// POST /api/mcp — Speakist MCP server.
//
// Implements the Model Context Protocol's JSON-RPC 2.0 surface over
// HTTP. Three methods we care about:
//
//   * `initialize`            handshake; returns server info + capabilities
//   * `tools/list`            enumerate available tools
//   * `tools/call`            invoke a tool by name with arguments
//
// Auth: every request needs `Authorization: Bearer ssat_<value>` —
// a service token minted at /admin/tokens. Tools declare their
// required scope; tools/list returns only tools whose scope the
// presenting token holds, so an LLM holding a read-only token sees
// only the read tools.
//
// Implemented as raw JSON-RPC rather than via @modelcontextprotocol/sdk
// because the SDK's transports target Node and our surface is small.

import { extractBearer } from "@/lib/bearer";
import {
  TOKEN_PREFIX,
  verifyServiceToken,
  type ServiceScope,
} from "@/lib/service-tokens";
import {
  ALL_TOOLS,
  findTool,
  McpError,
  type McpContent,
} from "@/lib/mcp/tools";

/** The protocol version we advertise on initialize. MCP clients are
 *  expected to either match or downgrade-gracefully — current Claude
 *  agents target 2025-06-18 or newer. We don't gate on the client's
 *  requested version; if a client speaks something older they can
 *  retry with the version we report back. */
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export async function POST(req: Request): Promise<Response> {
  // ---- auth ---------------------------------------------------------------
  const bearer = extractBearer(req);
  if (!bearer) {
    return Response.json(
      { error: "missing bearer token" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }
  if (!bearer.startsWith(TOKEN_PREFIX)) {
    return Response.json(
      { error: "wrong token type — MCP requires a service token (ssat_…)" },
      { status: 401 }
    );
  }
  const verified = await verifyServiceToken(bearer);
  if (!verified) {
    return Response.json(
      { error: "invalid or revoked service token" },
      { status: 401 }
    );
  }
  const tokenScopes = new Set<ServiceScope>(verified.scopes);

  // ---- parse JSON-RPC -----------------------------------------------------
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return rpcError(null, PARSE_ERROR, "invalid JSON");
  }

  // Batch support: spec says servers MAY accept arrays. Cheap to
  // honor — handle each request and concat the responses.
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      body.map((req) => handleSingle(req, tokenScopes, verified.id))
    );
    return Response.json(responses);
  }
  const response = await handleSingle(body, tokenScopes, verified.id);
  return Response.json(response);
}

async function handleSingle(
  req: JsonRpcRequest,
  tokenScopes: Set<ServiceScope>,
  tokenId: string
): Promise<JsonRpcSuccess | JsonRpcError> {
  const id = req.id ?? null;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return errorResponse(id, INVALID_REQUEST, "expected jsonrpc 2.0 with a method");
  }

  switch (req.method) {
    case "initialize":
      return successResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          // We expose tools, nothing else (no resources, no prompts,
          // no sampling).
          tools: {},
        },
        serverInfo: {
          name: "speakist",
          version: "1.0.0",
        },
        instructions:
          "Two related surfaces.\n\n" +
          "Feedback (the input to the active-learning loop): list_feedback enumerates user-reported bad transcriptions; get_feedback returns the full triplet (raw STT / what we delivered / what the user expected) plus the request-context snapshot; mark_feedback_proposed / mark_feedback_resolution move rows through the triage states. Audio is available via get_feedback_audio but rarely needed for polish-prompt iteration.\n\n" +
          "Polish prompts (the output): get_active_polish_prompt returns the body /api/transcribe is currently serving; list_polish_prompt_versions + get_polish_prompt_version expose the history; propose_polish_prompt promotes a candidate body to active. Always run the local polish regression bench before proposing — include bench_score and bench_results in the call so humans can verify the quality bar. Always include `notes` explaining WHY (which feedback IDs prompted this, what changes).",
      });

    case "tools/list": {
      // Filter to tools whose scope the presenting token holds. The
      // LLM should only see the tools it can actually invoke.
      const visible = ALL_TOOLS.filter((t) => tokenScopes.has(t.scope));
      return successResponse(id, {
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case "tools/call": {
      const params = req.params as
        | { name?: string; arguments?: unknown }
        | undefined;
      if (!params || typeof params.name !== "string") {
        return errorResponse(
          id,
          INVALID_PARAMS,
          "expected { name, arguments } in params"
        );
      }
      const tool = findTool(params.name);
      if (!tool) {
        return errorResponse(
          id,
          METHOD_NOT_FOUND,
          `unknown tool: ${params.name}`
        );
      }
      if (!tokenScopes.has(tool.scope)) {
        return errorResponse(
          id,
          INVALID_REQUEST,
          `service token missing required scope: ${tool.scope}`
        );
      }
      let content: McpContent[];
      try {
        content = await tool.handler(params.arguments, { tokenId });
      } catch (err) {
        if (err instanceof McpError) {
          // Surface as a tools/call result with `isError: true` per
          // MCP convention; the JSON-RPC envelope is still 2xx.
          return successResponse(id, {
            isError: true,
            content: [
              { type: "text", text: `${err.code}: ${err.message}` },
            ],
          });
        }
        if ((err as { name?: string })?.name === "ZodError") {
          return errorResponse(id, INVALID_PARAMS, (err as Error).message);
        }
        console.error(`[mcp] tool ${tool.name} threw:`, err);
        return errorResponse(
          id,
          INTERNAL_ERROR,
          err instanceof Error ? err.message : "internal error"
        );
      }
      return successResponse(id, { content });
    }

    case "ping":
      // Spec defines ping as a no-op for liveness checks.
      return successResponse(id, {});

    default:
      return errorResponse(
        id,
        METHOD_NOT_FOUND,
        `unknown method: ${req.method}`
      );
  }
}

// ---- envelope helpers -----------------------------------------------------

function successResponse(
  id: string | number | null,
  result: unknown
): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string
): Response {
  return Response.json(errorResponse(id, code, message));
}
