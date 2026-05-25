# STT bench fixtures

Audio + sidecar JSON pairs consumed by `pnpm bench:stt`. The harness scans this
directory, pairs each audio file with a same-name `.json` sidecar, and runs
every fixture against every configured provider (Deepgram + Groq Whisper by
default).

## Format

For each test case, drop two files in this directory:

```
my-fixture.wav         ← any of: .wav .mp3 .m4a .flac .ogg .webm
my-fixture.json        ← sidecar (same basename as the audio)
```

Sidecar schema (TypeScript-ish):

```jsonc
{
  // Free text; shown in the bench output. Not used for scoring.
  "description": "Vocab bleed: 'stripe' shouldn't snap to 'Stripe' (the company).",

  // The correct transcription. Used as the reference for Word-Error-Rate
  // (WER) scoring. Should be normal sentence case; the scorer lowercases
  // and strips punctuation before comparing.
  "groundTruth": "The stripe on my shirt is blue.",

  // OPTIONAL — vocab terms sent with the request, mimicking your account's
  // registered vocabulary. This is the variable that drives the vocab-bleed
  // failure mode. Mix real vocab terms (capitalized brand names, etc.) so
  // the provider's keyterm biasing is exercised.
  "keyterms": ["Stripe", "Anthropic", "Mytra"],

  // OPTIONAL — ISO 639 code (e.g. "en"). Omit for auto-detect (which is
  // also what the production /api/transcribe does when no language is set).
  "language": "en",

  // OPTIONAL — structural assertions. Each one fails the case independently.
  // For vocab-bleed tests, must_not_contain on the bleeding term is the
  // single most useful assertion.
  "expects": [
    { "kind": "must_not_contain", "substrings": ["Stripe"] },
    { "kind": "must_contain", "substrings": ["stripe"], "case_insensitive": true },
    { "kind": "max_wer", "ratio": 0.15 }
  ]
}
```

### Expectation kinds

- `must_contain` — output must contain every listed substring.
- `must_not_contain` — output must contain none of them. Use this for
  vocab-bleed tests (assert the bleeding term is NOT in the transcript).
- `max_wer` — Word-Error-Rate vs `groundTruth` must be ≤ this ratio. WER is
  computed after lowercasing and stripping punctuation, so providers aren't
  penalized for differing punctuation styles.

Both `must_contain` and `must_not_contain` accept `case_insensitive: true`.

## Audio recording tips

- **Format**: any common codec (the providers accept WAV/MP3/M4A/FLAC/OGG).
  16 kHz mono WAV matches what the iOS / Mac client sends.
- **Length**: keep fixtures short — 3-15 seconds is plenty. Long-form is
  better tested as a few short fixtures so individual failures are
  attributable.
- **Quiet environment**: don't introduce background noise as a confounder
  unless that's specifically what you're testing.
- **macOS quick recording**: QuickTime Player → File → New Audio Recording.
  Or for very quick smoke fixtures: `say "the text" -o test.aiff` then
  convert with `afconvert -f WAVE -d LEI16@16000 test.aiff test.wav`.
  (TTS-generated audio is too clean to reproduce most STT failures — use
  it for smoke testing only.)

## Audio files are gitignored by default

`.wav`/`.mp3`/etc. are excluded via `.gitignore` in this directory. Sidecar
`.json` files for **hand-curated** fixtures **are** committed so the
manifest of expected fixtures lives in version control even when the audio
doesn't. To force-commit an audio fixture, `git add -f path/to/fixture.wav`.

**Synced fixtures** (`feedback-<uuid>.{wav,json}`) — the JSON sidecar is
**also** gitignored because it embeds the user's dictated text, which can
contain PII. `git add -f` to commit specific ones.

## Syncing from the production feedback corpus

`pnpm bench:stt:sync` pulls bad-transcription reports (audio + raw STT +
user-corrected ground truth) from `/api/mcp` and writes them into this
directory as `feedback-<uuid>.{wav,json}` pairs. The bench harness picks
them up automatically.

```bash
# Mint a service token at /admin/tokens with feedback:read scope, then:
export SPEAKIST_MCP_ENDPOINT=https://speakist-dev.brevoortstudio.com
export SPEAKIST_MCP_TOKEN=ssat_...

# Pull everything:
pnpm bench:stt:sync

# Or incremental (newest-only since the last sync):
pnpm bench:stt:sync -- --since 2026-05-01T00:00:00Z

# See what would sync without writing anything:
pnpm bench:stt:sync -- --dry-run
```

Re-runs are idempotent: audio bytes are cached on disk, sidecars are
always refreshed from the latest MCP response. Vocab/keyterm context is
NOT captured by the feedback table today, so synced fixtures run with no
keyterms set — for vocab-bleed reproduction you'll still want a few
hand-curated fixtures alongside.

## Running

```bash
# Default: all providers, all fixtures, no polish.
pnpm bench:stt

# Single provider, specific model:
pnpm bench:stt -- --providers deepgram --model nova-2

# Pipe through polish before scoring — answers "does polish hide the bug?"
pnpm bench:stt -- --polish --polish-mode intuitive

# One fixture only, 3 iterations to smooth provider noise:
pnpm bench:stt -- --only vocab-bleed-stripe -n 3
```

Missing API keys are tolerated: a provider without its env var (e.g.
`DEEPGRAM_API_KEY`) is skipped silently, so you can run the bench with
just one provider configured.

## Vocab-bleed capture scenarios

Suggested fixtures to record when investigating the vocab-bleed issue:

1. **Pure homophone test** — pick a registered vocab term that has a common
   English homophone (or near-homophone). Dictate a sentence using the
   common word, NOT the brand. Example: registered "Stripe" → dictate
   "I painted a yellow stripe down the middle". Assert
   `must_not_contain: ["Stripe"]` (case-sensitive — lowercase "stripe" is
   correct; capitalized is the bleed).

2. **Blank context** — dictate a sentence with zero vocab-relevant content,
   with your real vocab list set. Confirms the provider isn't injecting
   vocab terms in unrelated speech. Example: "I went for a walk this
   morning and saw three deer in the field." `must_not_contain` every term
   in your vocab list.

3. **Acoustic near-miss** — find a word that sounds vaguely like a vocab
   term but isn't (e.g. "site" if "SRE" is registered). Dictate it in a
   plausible sentence. Assert the bleed term doesn't appear.

4. **Boundary words** — dictate a sentence where a vocab term sits at a
   word boundary that could fuse/split (e.g. "an Anthropic" vs "anthropic
   philosophy"). Useful for catching the over-eager boundary collapses.

5. **Correct positive case** — also include fixtures where the vocab term
   IS intended, so you know you haven't disabled the feature entirely.
   Assert `must_contain` the term, capitalized correctly.

Record each as a separate `.wav` + `.json`. Re-run `pnpm bench:stt` and
diff Deepgram vs Groq WER + assertion failures.
