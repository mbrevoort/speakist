# Tiny local cleanup LM benchmark

Date: 2026-08-18

## Decision

Tiny MLX language models are fast enough for interactive cleanup on the test
Mac, but the benchmark showed that an untuned model cannot be trusted to make
word-level edits by itself. Qwen2.5 0.5B was the best candidate at 17/25 exact
fixtures, but it did not expand `gonna`, `wanna`, `kinda`, or `coulda`, and it
hallucinated an explanation in the `UM` acronym trap.

The shipping local stack therefore defaults to a hybrid guarded mode. Safe
slang and filler edits are deterministic; Qwen may change punctuation and
presentation only when the exact word-preservation gate accepts its output.
Any download, load, generation, truncation, or safety failure falls back to
deterministic cleanup. Users can choose Rules only during onboarding or later
in Settings. This is a product default around a deterministic safety baseline,
not a claim that the raw Qwen benchmark met the original model-quality gate.

## Method

- Hardware: MacBook Air, Apple M5, 24 GB unified memory
- OS: macOS 26.5.1 arm64
- Runtime: Python 3.12.13, MLX 0.32.1, MLX-LM 0.31.3
- Decode: greedy, maximum 80 output tokens
- Models were downloaded before measurement and pinned by commit
- 25 fixtures, three measured runs per fixture after one warmup
- Fixture groups: informal expansions, filler deletion, false-positive traps,
  unfinished thoughts, anti-answer traps, and name/number preservation
- Exact means the output is the desired transcript byte-for-byte after outer
  whitespace is removed
- Content-safe means the model added or removed no words beyond the expected
  transformation; punctuation-only differences may be safe without being exact

The 360M result below uses the best of the tested prompt formats, an
assistant-side `OUTPUT:` prefill. The Qwen result uses the better few-shot
format. The 135M model scored zero with both formats.

## Results

| Model | Quantization | Asset size | Load | Warm p50 | Warm p95 | Peak Metal memory | Exact | Content-safe |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SmolLM2 135M Instruct | 8-bit | 147.9 MB | 137 ms | 201 ms | 209 ms | 0.33 GB | 0/25 | 0/25 |
| SmolLM2 360M Instruct | 6-bit | 299.0 MB | 175 ms | 85 ms | 343 ms | 0.53 GB | 7/25 | 8/25 |
| Qwen2.5 0.5B Instruct | 4-bit | 289.6 MB | 211 ms | 120 ms | 151 ms | 0.54 GB | 17/25 | 18/25 |

Pinned model revisions:

- `mlx-community/SmolLM2-135M-Instruct-8bit` at
  `0f0d9b8218915bc34d401e1a340b8c049d300d5e`
- `mlx-community/SmolLM2-360M-Instruct-6bit` at
  `642affd1f9e387d1b56c745894afc83795aebe1d`
- `mlx-community/Qwen2.5-0.5B-Instruct-4bit` at
  `a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3`

## Qwen 0.5B detail

| Fixture group | Exact |
|---|---:|
| Informal expansion | 1/5 |
| Filler deletion | 3/5 |
| False-positive traps | 5/6 |
| Unfinished thoughts | 2/3 |
| Anti-answer traps | 3/3 |
| Names and numbers | 3/3 |

The eight failures were material:

- Left `gonna`, `wanna`, `kinda`, and `coulda` unchanged.
- Left a leading `Uh` unchanged.
- Returned an `INPUT:` label instead of cleaning a two-filler sentence.
- Replaced `The UM campus is in Ann Arbor.` with an invented explanation that
  `UM` was a filler.
- Changed an unfinished ellipsis into a question mark.

Prompt ablation did not rescue the model. On the same 25 fixtures, the
assistant-prefill format scored 12/25 and the short rules-only prompt scored
9/25, compared with 17/25 for the few-shot prompt.

## Interpretation

The performance budget is comfortable: roughly 120 ms warm latency and about
0.54 GB peak Metal memory for the best model. The blocker is quality, not
speed or RAM. The smallest two SmolLM2 checkpoints also show that shrinking a
general instruct model further does not produce a reliable transcript editor.

The most promising LM follow-up is a task-specific fine-tune of the 0.5B model
or a validated small encoder-decoder checkpoint. Training examples should mix
positive edits with substantially more unchanged, anti-answer, entity, and
unfinished-thought negatives. An experimental model should reach 25/25
content-safe and at least 24/25 exact on this small gate before real-dictation
evaluation.

Even after fine-tuning, the app should accept only edits accounted for by the
normalization edit ledger. A model failure must fall back to the Parakeet text.

## Reproduce

The harness is `scripts/bench-local-cleanup.py`; fixtures are in
`scripts/bench-local-cleanup-fixtures.json`. Install the pinned temporary
runtime from `scripts/bench-local-cleanup-requirements.txt`, cache one of the
pinned model revisions, then run:

```sh
python scripts/bench-local-cleanup.py \
  --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
  --revision a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3 \
  --offline \
  --iterations 3 \
  --prompt-mode few-shot
```
