// Cross-environment mirror for the polish-prompt active row.
//
// Today: prod → dev only. Triggered by:
//   * The /api/admin/polish-prompts/mirror REST route (curl-able with
//     a session cookie; useful for scripts + testing).
//   * The "Mirror → dev" server action on /admin/polish-prompts.
//
// Both call mirrorActivePromptToDev(mode); auth is handled by the
// caller (super admin gate) and configuration preconditions are
// checked here so the failure shape is consistent regardless of
// entry point.
//
// Wire: this Worker reads getActivePrompt(mode) locally, then POSTs
// to ${DEV_MIRROR_BACKEND_URL}/api/admin/polish-prompts/mirror-receive
// with `Authorization: Bearer ${DEV_MIRROR_TOKEN}`. The dev Worker
// runs its own createVersion with source='mirror' and the notes
// prefix "Mirrored from prod v{N}", then fires its own Slack
// prompt_update channel.
//
// Setup is documented in docs/polish-prompt-mirror.md.

import { env } from "@/lib/env";
import {
  getActivePrompt,
  type PolishPromptMode,
} from "@/lib/polish-prompts";

const MIRROR_RECEIVE_PATH = "/api/admin/polish-prompts/mirror-receive";

/** Discriminated success / failure result. The HTTP route and the
 *  server action both map this directly onto their response shapes;
 *  callers never throw on expected business failures (config not
 *  set, no active version, dev unreachable). */
export type MirrorResult =
  | {
      ok: true;
      sourceVersion: number;
      sourceBenchScore: number | null;
      devId: string | null;
      devVersion: number | null;
    }
  | {
      ok: false;
      /** Maps cleanly onto an HTTP status — 412 for unmet
       *  preconditions, 502 for transport / remote rejection. */
      status: 412 | 502;
      error:
        | "mirror_not_configured"
        | "no_active_version"
        | "dev_unreachable"
        | "dev_rejected";
      detail: string;
      /** Set when `error === 'dev_rejected'`: the remote's status
       *  code so callers can show it without re-parsing detail. */
      devStatus?: number;
    };

export async function mirrorActivePromptToDev(
  mode: PolishPromptMode
): Promise<MirrorResult> {
  // ---- preconditions --------------------------------------------------------
  const server = env.server;
  const backendUrl = server.DEV_MIRROR_BACKEND_URL;
  const token = server.DEV_MIRROR_TOKEN;
  if (!backendUrl || !token) {
    return {
      ok: false,
      status: 412,
      error: "mirror_not_configured",
      detail:
        "Set DEV_MIRROR_BACKEND_URL (wrangler.toml [env.production.vars]) and DEV_MIRROR_TOKEN (`wrangler secret put DEV_MIRROR_TOKEN --env production`). See docs/polish-prompt-mirror.md.",
    };
  }

  const active = await getActivePrompt(mode);
  if (!active) {
    return {
      ok: false,
      status: 412,
      error: "no_active_version",
      detail: `No active polish-prompt version for mode='${mode}' on this env — nothing to mirror.`,
    };
  }

  // ---- POST -----------------------------------------------------------------
  const url = new URL(MIRROR_RECEIVE_PATH, backendUrl).toString();
  let dev: Response;
  try {
    dev = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: active.mode,
        body: active.body,
        notes: active.notes ?? undefined,
        source_version: active.version,
        source_bench_score: active.benchScore ?? undefined,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: "dev_unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!dev.ok) {
    const text = await dev.text().catch(() => "<unreadable>");
    return {
      ok: false,
      status: 502,
      error: "dev_rejected",
      detail: text.slice(0, 500),
      devStatus: dev.status,
    };
  }

  // Receiver returns `{ id, mode, version, is_active }`. We surface
  // `dev_id` + `dev_version` so the admin UI's toast can say
  // "now dev v{N}".
  const devBody = (await dev.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return {
    ok: true,
    sourceVersion: active.version,
    sourceBenchScore: active.benchScore,
    devId: typeof devBody.id === "string" ? devBody.id : null,
    devVersion:
      typeof devBody.version === "number" ? devBody.version : null,
  };
}

/** Cheap server-side check used by /admin/polish-prompts (RSC) to
 *  decide whether to enable the "Mirror → dev" button. Returns true
 *  iff both env values are present — doesn't actually attempt a
 *  request. The button click invokes the action which surfaces any
 *  runtime failure. */
export function isMirrorConfigured(): boolean {
  const server = env.server;
  return Boolean(server.DEV_MIRROR_BACKEND_URL && server.DEV_MIRROR_TOKEN);
}
