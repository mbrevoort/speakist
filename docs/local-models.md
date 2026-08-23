# Local speech and cleanup models

This document records the local-first model decision for the Mac app. The
runtime is intentionally split into speech recognition and text cleanup so a
cleanup model can be replaced without changing Parakeet or the paste path.
The shipping app targets Apple silicon Macs on macOS 14 or later because the
guarded cleanup pass uses MLX.

## Current local path

| Stage | Implementation | Network after first install | Notes |
|---|---|---:|---|
| Speech recognition | FluidAudio 0.15.5, Parakeet TDT v2, INT8 encoder | No | English, Core ML, record-then-transcribe |
| Exact vocabulary | `LocalTranscriptCorrections` | No | Case-insensitive, whole-token aliases; no fuzzy acoustic rewriting |
| Pause cleanup | `DeterministicLocalTranscriptCleanup` | No | Uses Parakeet token timing gaps; never invents text |
| Speech-style cleanup | `LocalSpeechStyleNormalizer` | No | Qwen mode only; removes protected fillers and expands five casual forms deterministically |
| Guarded presentation cleanup | MLX Swift LM 3.31.3, Qwen2.5 0.5B Instruct 4-bit | No | New installs default on; unsafe word changes fall back to the deterministic result |

The conservative option performs only content-preserving edits: it joins a
strongly incomplete clause across a decoded thinking pause, normalizes spacing,
and restores a small list of unambiguous contractions. The guarded Qwen
option first handles `um`/`uh`/`erm` and casual forms such as `gonna`
deterministically, then asks Qwen to clean presentation. The content gate only
accepts a model candidate whose normalized word sequence exactly matches that
safe baseline. History records whether cleanup changed the transcript in
`cleanup_applied`.

Qwen is pinned to `mlx-community/Qwen2.5-0.5B-Instruct-4bit` revision
`a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3`. It downloads on first use and is
cached by the Hugging Face Swift client. If download, loading, or generation
fails, the transcript continues through the deterministic fallback.

Active proper-noun correction rows are exact aliases. For example, `Breford`,
`Bervort`, `Berfort`, and `prevoort` can all map to `Brevoort`, but only those
whole tokens are replaced. Fuzzy acoustic rescoring was removed after retained
audio showed that it rewrote ordinary words such as `change`, `want`,
`README`, and `previous` into names.

The original TDT output is retained in History before exact replacements or
cleanup. When an edit maps a single misspelled token to a similar canonical
term that already has an active STT rule, Speakist can activate it as another
local alias. Multi-word phrases, valid English source words, and dissimilar
spellings remain staged for explicit approval; this prevents ordinary words
such as `change` or `want` from becoming name replacements.

## Name vocabulary benchmark

`ParakeetNameBenchmarkTests` is an opt-in local benchmark. It reads a temporary
`/private/tmp/speakist-name-benchmark.txt` manifest whose positive paths begin
with `+` and negative-control paths begin with `-`; the normal suite skips it
when the manifest is absent.

The current retained-audio release gate covers exact positive aliases and
ordinary-word negative controls. The latest run replaced 2/2 explicit aliases
(`Breford` and `Walty`) and changed 0/2 long negative recordings. The negative
recordings include the original phrases that were previously corrupted into
`Jeanie`, `Walti`, and `Brevoort`.

## Model candidate validation

The first native candidate was
[`goodpixelltd/t5-grammar-coreml`](https://huggingface.co/goodpixelltd/t5-grammar-coreml),
a Core ML conversion of the speech-oriented
[`flexudy/t5-small-wav2vec2-grammar-fixer`](https://huggingface.co/flexudy/t5-small-wav2vec2-grammar-fixer).
The model card specifies CPU-only execution, a 128-token input, and greedy
autoregressive decoding. Its published encoder and decoder were loaded with
`MLModel` and exercised on this Mac using both dynamic and fixed-size inputs.
The encoder returned Float16 NaN tensors and the decoder returned NaN logits,
so the candidate is not used by the app. This is a runtime/model validation
failure, not a reason to weaken the fail-closed transcript path.

## Acceptance criteria for a future local grammar model

1. It must run in-process on supported macOS versions without a Python or
   cloud dependency.
2. A fixed regression set must measure latency, memory, and edits against the
   deterministic baseline.
3. The output must preserve named entities, numbers, user Vocabulary terms,
   and every non-filler content token. Unsafe rewrites fall back to the input.
4. A pause-aware fixture must show that a thinking pause does not force an
   artificial sentence boundary; the model may not complete a thought that is
   absent from the audio.
5. The model asset and tokenizer must be pinned by revision and license, with
   a first-use download that can be interrupted and retried safely.

The next quality step is a task-specific adapter/fine-tune. Until that reaches
the full safety gate, the app deliberately does not accept Qwen word-level
grammar rewrites.

## Tiny instruct-model benchmark

The follow-up MLX benchmark tested SmolLM2 135M, SmolLM2 360M, and Qwen2.5
0.5B on an Apple M5. All three met the latency budget, but none met the cleanup
quality gate. Qwen2.5 0.5B was best at 17/25 exact fixtures and approximately
120 ms warm median latency, yet it failed the central `gonna` expansion and
hallucinated content in an acronym trap. See
[`local-cleanup-lm-benchmark.md`](local-cleanup-lm-benchmark.md) for pinned
revisions, measurements, failures, and the reproducible harness.
