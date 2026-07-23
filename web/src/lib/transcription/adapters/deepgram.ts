// Deepgram /v1/listen adapter.
//
// Deepgram accepts the raw audio body as-is (no multipart wrapping); all
// knobs go in query params. That's why we construct a URL with URLSearchParams
// rather than FormData.
//
// Param dialect varies by model: Nova-3 uses `keyterm`, Nova-2 uses
// `keywords`. `replace=find:replacement` is accepted by both.

import type { ProviderAdapter, TranscriptionInput, TranscriptionOutput } from "../types";

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const MODELS = ["nova-3", "nova-2"] as const;

/** The subset of a transcription request that maps to Deepgram query
 *  params. Both the batch adapter (below) and the streaming proxy
 *  (`../stream.ts`) build their URL from this so the two paths can't drift
 *  on model/vocab/language handling. */
export interface DeepgramParamOpts {
  model: string;
  dictation?: boolean;
  fillerWords?: boolean;
  measurements?: boolean;
  profanityFilter?: boolean;
  detectLanguage?: boolean;
  language?: string;
  keyterms?: string[];
  replaceRules?: string[]; // "find:replacement" pairs
}

/**
 * Build the Deepgram `/v1/listen` query params shared by the batch REST
 * call and the live WebSocket. Streaming-only params (encoding, sample
 * rate, interim results) are added by the caller on top of these.
 */
export function buildDeepgramQuery(opts: DeepgramParamOpts): URLSearchParams {
  const q = new URLSearchParams();

  q.set("model", opts.model);
  q.set("smart_format", "true");
  q.set("punctuate", "true");

  if (opts.dictation) q.set("dictation", "true");
  if (opts.fillerWords) q.set("filler_words", "true");
  if (opts.measurements) q.set("measurements", "true");
  if (opts.profanityFilter) q.set("profanity_filter", "true");

  // `language` and `detect_language` are mutually exclusive on Deepgram's
  // side — setting both returns 400.
  if (opts.detectLanguage) {
    q.set("detect_language", "true");
  } else if (opts.language && opts.language.length > 0) {
    q.set("language", opts.language);
  }

  // Custom vocab: `keyterm` on Nova-3, `keywords` on Nova-2. Repeatable.
  const termParam = opts.model === "nova-3" ? "keyterm" : "keywords";
  for (const term of opts.keyterms ?? []) {
    if (term.length > 0) q.append(termParam, term);
  }

  // `replace=find:replacement` pairs. Client is responsible for validation
  // (no colon in find/replacement). Cap at 200 per Deepgram's documented
  // limit; extras silently ignored.
  const rules = (opts.replaceRules ?? []).slice(0, 200);
  for (const rule of rules) {
    if (rule.length > 0) q.append("replace", rule);
  }

  return q;
}

function buildRequest(input: TranscriptionInput, apiKey: string): Request {
  const url = new URL(DEEPGRAM_URL);
  url.search = buildDeepgramQuery(input).toString();

  return new Request(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": input.audioContentType || "audio/wav",
    },
    body: input.audioBody,
  });
}

async function parseResponse(res: Response): Promise<TranscriptionOutput> {
  const body = (await res.json()) as DeepgramResponse;
  const text = body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  const audioSeconds = body.metadata?.duration ?? 0;
  return { text, audioSeconds };
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
}

export const deepgramAdapter: ProviderAdapter = {
  id: "deepgram",
  models: MODELS,
  buildRequest,
  parseResponse,
};
