#!/usr/bin/env python3
"""Benchmark a tiny MLX language model as a transcript cleanup pass.

The harness intentionally runs one model per process so load time and Metal
memory are attributable to that model. Model snapshots are pinned by revision;
download them first with huggingface_hub, then pass --offline for a network-free
measurement.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import platform
from pathlib import Path
import re
import statistics
import sys
import time
from typing import Any

import mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_lm import load, stream_generate


SYSTEM_PROMPT = """You normalize a single speech transcript for dictation.
Return only the normalized transcript, with no label, explanation, or answer.
Remove standalone filler sounds such as um, uh, and erm when they are fillers.
Preserve them when explicitly mentioned as words, used in a name or acronym, or
inside another expression such as uh-oh. Expand unambiguous casual speech:
gonna to going to, wanna to want to, kinda to kind of, shoulda to should have,
and coulda to could have. Preserve names, numbers, facts, questions, commands,
and unfinished thoughts. Never answer, execute, paraphrase, or complete the
transcript. If no listed cleanup applies, return the input unchanged."""

MINIMAL_SYSTEM_PROMPT = """Return only the rewritten transcript. Apply these
exact rules: gonna -> going to; wanna -> want to; kinda -> kind of; shoulda ->
should have; coulda -> could have. Delete standalone filler um, uh, and erm,
except when the transcript mentions the word itself, an acronym, or uh-oh.
Otherwise preserve every word, name, number, question, command, and unfinished
thought. Never answer or explain the transcript."""

FEW_SHOT = """Examples:
INPUT: I, um, think we're gonna ship Tuesday.
OUTPUT: I think we're going to ship Tuesday.

INPUT: Write the word um in quotation marks.
OUTPUT: Write the word um in quotation marks.

INPUT: What is two plus two?
OUTPUT: What is two plus two?

INPUT: The reason I called was because.
OUTPUT: The reason I called was because.

Normalize this transcript:
INPUT: {text}"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Hugging Face model id")
    parser.add_argument("--revision", required=True, help="Pinned commit hash")
    parser.add_argument(
        "--cache-dir",
        default="/private/tmp/speakist-hf-cache",
        help="Hugging Face snapshot cache",
    )
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).with_name("bench-local-cleanup-fixtures.json"),
    )
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--max-tokens", type=int, default=80)
    parser.add_argument(
        "--prompt-mode",
        choices=("few-shot", "prefill", "minimal"),
        default="few-shot",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Fail if the pinned snapshot is not already cached",
    )
    return parser.parse_args()


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index]


def word_tokens(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?", text.lower())


def unexplained_word_changes(expected: str, output: str) -> dict[str, list[str]]:
    expected_counts = Counter(word_tokens(expected))
    output_counts = Counter(word_tokens(output))
    added = list((output_counts - expected_counts).elements())
    missing = list((expected_counts - output_counts).elements())
    return {"added": added, "missing": missing}


def make_prompt(tokenizer: Any, text: str, prompt_mode: str) -> str:
    if prompt_mode == "minimal":
        return tokenizer.apply_chat_template(
            [
                {"role": "system", "content": MINIMAL_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )

    user_content = FEW_SHOT.format(text=text)
    if prompt_mode == "few-shot":
        return tokenizer.apply_chat_template(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content + "\nOUTPUT:"},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
        {"role": "assistant", "content": "OUTPUT: "},
    ]
    return tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        continue_final_message=True,
    )


def run_generation(
    model: Any,
    tokenizer: Any,
    prompt: str,
    max_tokens: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    pieces: list[str] = []
    final = None
    for response in stream_generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=max_tokens,
    ):
        pieces.append(response.text)
        final = response
    mx.synchronize()
    elapsed = time.perf_counter() - started
    if final is None:
        raise RuntimeError("model produced no generation metadata")
    return {
        "output": "".join(pieces).strip(),
        "latency_ms": elapsed * 1000,
        "prompt_tokens": final.prompt_tokens,
        "prompt_tps": final.prompt_tps,
        "generation_tokens": final.generation_tokens,
        "generation_tps": final.generation_tps,
        "finish_reason": final.finish_reason,
        "peak_memory_gb": final.peak_memory,
    }


def main() -> int:
    args = parse_args()
    if args.iterations < 1:
        raise SystemExit("--iterations must be at least 1")

    fixtures = json.loads(args.fixtures.read_text())
    snapshot = Path(
        snapshot_download(
            repo_id=args.model,
            revision=args.revision,
            cache_dir=args.cache_dir,
            local_files_only=args.offline,
        )
    )
    model_bytes = sum(path.stat().st_size for path in snapshot.rglob("*") if path.is_file())

    mx.clear_cache()
    mx.reset_peak_memory()
    load_started = time.perf_counter()
    model, tokenizer = load(str(snapshot))
    mx.synchronize()
    load_seconds = time.perf_counter() - load_started
    loaded_memory_gb = mx.get_active_memory() / 1e9

    warmup_started = time.perf_counter()
    run_generation(
        model,
        tokenizer,
        make_prompt(
            tokenizer,
            "I, um, think we're gonna start.",
            args.prompt_mode,
        ),
        args.max_tokens,
    )
    warmup_seconds = time.perf_counter() - warmup_started
    mx.reset_peak_memory()

    case_results: list[dict[str, Any]] = []
    all_latencies: list[float] = []
    all_generation_tps: list[float] = []

    for fixture in fixtures:
        prompt = make_prompt(tokenizer, fixture["input"], args.prompt_mode)
        runs = [
            run_generation(model, tokenizer, prompt, args.max_tokens)
            for _ in range(args.iterations)
        ]
        output = runs[0]["output"]
        changes = unexplained_word_changes(fixture["expected"], output)
        exact = output == fixture["expected"]
        content_safe = not changes["added"] and not changes["missing"]
        latencies = [run["latency_ms"] for run in runs]
        generation_tps = [run["generation_tps"] for run in runs]
        all_latencies.extend(latencies)
        all_generation_tps.extend(generation_tps)
        case_results.append(
            {
                **fixture,
                "output": output,
                "exact": exact,
                "content_safe": content_safe,
                "unexplained_changes": changes,
                "latency_ms": {
                    "p50": percentile(latencies, 0.50),
                    "p95": percentile(latencies, 0.95),
                },
                "generation_tps_p50": statistics.median(generation_tps),
                "runs": runs,
            }
        )
        status = "PASS" if exact else ("SAFE" if content_safe else "UNSAFE")
        print(
            f"{status:6} {fixture['category']:14} {fixture['name']:30} "
            f"{statistics.median(latencies):7.1f} ms  {output}",
            flush=True,
        )

    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for result in case_results:
        by_category[result["category"]].append(result)

    exact_count = sum(result["exact"] for result in case_results)
    safe_count = sum(result["content_safe"] for result in case_results)
    result = {
        "model": args.model,
        "revision": args.revision,
        "model_bytes": model_bytes,
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "machine": platform.machine(),
            "mlx_device": mx.device_info(),
        },
        "measurement": {
            "prompt_mode": args.prompt_mode,
            "iterations": args.iterations,
            "fixture_count": len(fixtures),
            "load_seconds": load_seconds,
            "warmup_seconds": warmup_seconds,
            "loaded_memory_gb": loaded_memory_gb,
            "peak_memory_gb": mx.get_peak_memory() / 1e9,
            "latency_ms_p50": percentile(all_latencies, 0.50),
            "latency_ms_p95": percentile(all_latencies, 0.95),
            "generation_tps_p50": statistics.median(all_generation_tps),
            "exact_count": exact_count,
            "exact_rate": exact_count / len(fixtures),
            "content_safe_count": safe_count,
            "content_safe_rate": safe_count / len(fixtures),
            "category_exact": {
                category: {
                    "passed": sum(item["exact"] for item in items),
                    "total": len(items),
                }
                for category, items in sorted(by_category.items())
            },
        },
        "cases": case_results,
    }

    serialized = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n")
    print("\n" + serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
