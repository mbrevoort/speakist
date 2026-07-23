// Locks the Deepgram query-param dialect shared by the batch adapter and
// the streaming proxy (buildDeepgramQuery). If these drift, batch and
// streaming transcripts diverge on vocab/language handling.

import { describe, expect, it } from "vitest";
import { buildDeepgramQuery } from "@/lib/transcription/adapters/deepgram";

describe("buildDeepgramQuery", () => {
  it("always sets model, smart_format, punctuate", () => {
    const q = buildDeepgramQuery({ model: "nova-3" });
    expect(q.get("model")).toBe("nova-3");
    expect(q.get("smart_format")).toBe("true");
    expect(q.get("punctuate")).toBe("true");
  });

  it("sets language when given and not auto-detecting", () => {
    const q = buildDeepgramQuery({ model: "nova-3", language: "en" });
    expect(q.get("language")).toBe("en");
    expect(q.get("detect_language")).toBeNull();
  });

  it("prefers detect_language and omits language (mutually exclusive)", () => {
    const q = buildDeepgramQuery({ model: "nova-3", language: "en", detectLanguage: true });
    expect(q.get("detect_language")).toBe("true");
    expect(q.get("language")).toBeNull();
  });

  it("uses keyterm on nova-3 and keywords on nova-2", () => {
    const n3 = buildDeepgramQuery({ model: "nova-3", keyterms: ["Speakist", "Deepgram"] });
    expect(n3.getAll("keyterm")).toEqual(["Speakist", "Deepgram"]);
    expect(n3.getAll("keywords")).toEqual([]);

    const n2 = buildDeepgramQuery({ model: "nova-2", keyterms: ["Speakist"] });
    expect(n2.getAll("keywords")).toEqual(["Speakist"]);
    expect(n2.getAll("keyterm")).toEqual([]);
  });

  it("appends replace pairs and passes through the flag toggles", () => {
    const q = buildDeepgramQuery({
      model: "nova-3",
      replaceRules: ["teh:the", "wont:won't"],
      dictation: true,
      fillerWords: true,
      measurements: true,
      profanityFilter: true,
    });
    expect(q.getAll("replace")).toEqual(["teh:the", "wont:won't"]);
    expect(q.get("dictation")).toBe("true");
    expect(q.get("filler_words")).toBe("true");
    expect(q.get("measurements")).toBe("true");
    expect(q.get("profanity_filter")).toBe("true");
  });
});
