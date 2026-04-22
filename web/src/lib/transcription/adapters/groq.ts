// Groq /openai/v1/audio/transcriptions adapter.
//
// Groq exposes a drop-in-compatible OpenAI Audio Transcriptions endpoint:
// multipart/form-data POST with `file` (audio bytes), `model`, and optional
// `language` + `prompt` + `response_format` fields. Auth: Bearer.
//
// Knob mapping (what the Speakist Mac app sends vs what Groq actually uses):
//   * language          → form field `language`
//   * keyterms          → concatenated into form field `prompt` (Whisper's
//                         steering mechanism; up to 224 tokens)
//   * replaceRules      → dropped. Whisper has no find/replace. Corrections
//                         still apply on the client-side cleanup pass.
//   * dictation / fillerWords / measurements / profanityFilter / detectLanguage
//                       → all dropped; Whisper doesn't have these as
//                         explicit knobs. detectLanguage is the *default*
//                         Whisper behavior when `language` is absent.
//
// Response: we request `response_format=verbose_json` so the response
// includes `duration` for cost computation; the plain `json` format only
// returns `text`.

import type { ProviderAdapter, TranscriptionInput, TranscriptionOutput } from "../types";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const;

/** Whisper steering prompt max length is 224 tokens; we approximate as
 *  ~900 characters (4 chars/token) and truncate defensively so we never
 *  trip Groq's 400 error on oversized prompts. */
const MAX_PROMPT_CHARS = 900;

function buildRequest(input: TranscriptionInput, apiKey: string): Request {
  const form = new FormData();

  // `file` must be a Blob-like with a filename. Content-type hint helps
  // Groq's decoder pick the right backend.
  form.set(
    "file",
    new Blob([input.audioBody], { type: input.audioContentType || "audio/wav" }),
    filenameForContentType(input.audioContentType)
  );
  form.set("model", input.model);
  form.set("response_format", "verbose_json");

  // Whisper's `detect_language` isn't a boolean — it's implicit when
  // `language` is absent. Respect detectLanguage by NOT sending `language`,
  // otherwise forward the ISO code.
  if (!input.detectLanguage && input.language && input.language.length > 0) {
    form.set("language", input.language);
  }

  // Seed Whisper's steering prompt with top keyterms, comma-separated.
  // This is our best-effort analog of Deepgram's keyterm boosting.
  const keyterms = (input.keyterms ?? []).filter((s) => s.length > 0);
  if (keyterms.length > 0) {
    let prompt = keyterms.join(", ");
    if (prompt.length > MAX_PROMPT_CHARS) {
      prompt = prompt.slice(0, MAX_PROMPT_CHARS);
    }
    form.set("prompt", prompt);
  }

  return new Request(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // DON'T set Content-Type manually — FormData needs to set its own
      // multipart boundary.
    },
    body: form,
  });
}

async function parseResponse(res: Response): Promise<TranscriptionOutput> {
  const body = (await res.json()) as GroqResponse;
  return {
    text: body.text ?? "",
    audioSeconds: body.duration ?? 0,
  };
}

/** Subset of verbose_json we care about. Groq also returns `segments`,
 *  `language`, `task` — we ignore them (segments would be useful for
 *  word-level timestamps in a future history UI enhancement). */
interface GroqResponse {
  text?: string;
  duration?: number;
}

/** Filename Groq sees in the multipart part. Not strictly required but
 *  some servers reject unnamed parts, and the extension disambiguates the
 *  decoder. We match the content-type we were handed. */
function filenameForContentType(contentType: string): string {
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "audio.mp3";
  if (contentType.includes("ogg")) return "audio.ogg";
  if (contentType.includes("flac")) return "audio.flac";
  return "audio.wav";
}

export const groqAdapter: ProviderAdapter = {
  id: "groq",
  models: MODELS,
  buildRequest,
  parseResponse,
};
