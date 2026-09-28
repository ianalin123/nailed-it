"""Score a blind ratings.json export against key.json (id -> "base" | "trained").

Prints per-source counts, the share nailed, a nailed=1/partly=0.5/off=0 score
(skips excluded), the trained-minus-base difference with a seeded bootstrap 95%
interval, a plain verdict, and median time per read per source. Writes the same
result as JSON.

Usage:
    python3 score_ratings.py --ratings RATINGS --key KEY --out OUT --seed SEED
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
TRAINING_ROOT = TOOLS_DIR.parent
DEFAULT_RATINGS = TRAINING_ROOT / ".spend" / "blind" / "ratings.json"
DEFAULT_KEY = TRAINING_ROOT / ".spend" / "blind" / "key.json"
DEFAULT_SCORE_OUT = TRAINING_ROOT / ".spend" / "blind" / "score.json"

MIN_RATED_PER_SOURCE = 10
SOURCES = ("base", "trained")
ANSWER_VALUES = {"nailed": 1.0, "partly": 0.5, "off": 0.0}


class InsufficientSampleError(RuntimeError):
    """Raised when a source has fewer than MIN_RATED_PER_SOURCE rated (non-skip) reads."""


def load_ratings(path: Path) -> dict:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"could not read ratings file {path}: {exc}") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"ratings file {path} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict) or "ratings" not in payload:
        raise ValueError(f"ratings file {path} must be a JSON object with a 'ratings' array")
    if not isinstance(payload["ratings"], list):
        raise ValueError(f"'ratings' in {path} must be an array")
    return payload


def load_key(path: Path) -> dict[str, str]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"could not read key file {path}: {exc}") from exc
    try:
        key = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"key file {path} is not valid JSON: {exc}") from exc
    if not isinstance(key, dict):
        raise ValueError(f"key file {path} must be a JSON object mapping id to source")
    for entry_id, source in key.items():
        if source not in SOURCES:
            raise ValueError(f"key file {path} has an invalid source '{source}' for id '{entry_id}'")
    return key


def join_by_source(ratings: list[dict], key: dict[str, str]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {source: [] for source in SOURCES}
    for rating in ratings:
        source = key.get(rating["id"])
        if source in grouped:
            grouped[source].append(rating)
    return grouped


def summarize_source(ratings_for_source: list[dict]) -> dict:
    counts = {"nailed": 0, "partly": 0, "off": 0, "skip": 0}
    for rating in ratings_for_source:
        answer = rating["answer"]
        if answer not in counts:
            raise ValueError(f"unknown answer '{answer}' for id '{rating.get('id')}'")
        counts[answer] += 1

    n_rated = counts["nailed"] + counts["partly"] + counts["off"]
    score = (counts["nailed"] * ANSWER_VALUES["nailed"] + counts["partly"] * ANSWER_VALUES["partly"]) / n_rated if n_rated else 0.0
    share_nailed = counts["nailed"] / n_rated if n_rated else 0.0
    times = [rating["ms"] for rating in ratings_for_source if isinstance(rating.get("ms"), (int, float))]
    median_ms = statistics.median(times) if times else 0.0

    return {
        "counts": counts,
        "n_rated": n_rated,
        "n_total": len(ratings_for_source),
        "share_nailed": share_nailed,
        "score": score,
        "median_ms": median_ms,
    }


def _score_values(ratings_for_source: list[dict]) -> list[float]:
    return [ANSWER_VALUES[rating["answer"]] for rating in ratings_for_source if rating["answer"] in ANSWER_VALUES]


def bootstrap_diff_ci(base_ratings: list[dict], trained_ratings: list[dict], seed: int, n_boot: int = 10000) -> tuple[float, float]:
    base_scores = _score_values(base_ratings)
    trained_scores = _score_values(trained_ratings)
    if not base_scores or not trained_scores:
        raise ValueError("cannot bootstrap a difference with no rated reads in one source")

    rng = random.Random(seed)
    diffs = []
    for _ in range(n_boot):
        base_mean = sum(base_scores[rng.randrange(len(base_scores))] for _ in range(len(base_scores))) / len(base_scores)
        trained_mean = sum(trained_scores[rng.randrange(len(trained_scores))] for _ in range(len(trained_scores))) / len(trained_scores)
        diffs.append(trained_mean - base_mean)

    diffs.sort()
    lo_index = max(0, min(n_boot - 1, round(0.025 * (n_boot - 1))))
    hi_index = max(0, min(n_boot - 1, round(0.975 * (n_boot - 1))))
    return diffs[lo_index], diffs[hi_index]


def compute_verdict(lo: float, hi: float) -> str:
    if lo > 0:
        return "trained better"
    if hi < 0:
        return "base better"
    return "not distinguishable"


def score(ratings_path: Path, key_path: Path, seed: int, n_boot: int = 10000) -> dict:
    payload = load_ratings(ratings_path)
    key = load_key(key_path)
    grouped = join_by_source(payload["ratings"], key)

    summaries = {source: summarize_source(entries) for source, entries in grouped.items()}
    if any(summaries[source]["n_rated"] < MIN_RATED_PER_SOURCE for source in SOURCES):
        raise InsufficientSampleError(
            f"need at least {MIN_RATED_PER_SOURCE} rated (non-skip) reads per source; "
            f"got base={summaries['base']['n_rated']}, trained={summaries['trained']['n_rated']}"
        )

    lo, hi = bootstrap_diff_ci(grouped["base"], grouped["trained"], seed=seed, n_boot=n_boot)

    return {
        "sample_size": {"base": summaries["base"]["n_rated"], "trained": summaries["trained"]["n_rated"]},
        "base": summaries["base"],
        "trained": summaries["trained"],
        "diff": {"score": summaries["trained"]["score"] - summaries["base"]["score"], "ci95": [lo, hi]},
        "verdict": compute_verdict(lo, hi),
        "seed": seed,
        "poolHash": payload.get("poolHash"),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Score a blind ratings export against key.json.")
    parser.add_argument("--ratings", type=Path, default=DEFAULT_RATINGS, help=f"path to ratings.json (default: {DEFAULT_RATINGS})")
    parser.add_argument("--key", type=Path, default=DEFAULT_KEY, help=f"path to key.json (default: {DEFAULT_KEY})")
    parser.add_argument("--out", type=Path, default=DEFAULT_SCORE_OUT, help=f"path to write score.json (default: {DEFAULT_SCORE_OUT})")
    parser.add_argument("--seed", type=int, default=0, help="bootstrap seed (default: 0)")
    parser.add_argument("--n-boot", type=int, default=10000, help="bootstrap resample count (default: 10000)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = score(args.ratings, args.key, args.seed, args.n_boot)
    except (ValueError, InsufficientSampleError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"sample size: base={result['sample_size']['base']} trained={result['sample_size']['trained']}")
    print(
        f"base score:    {result['base']['score']:.3f} "
        f"(nailed share {result['base']['share_nailed']:.3f}, n={result['base']['n_rated']})"
    )
    print(
        f"trained score: {result['trained']['score']:.3f} "
        f"(nailed share {result['trained']['share_nailed']:.3f}, n={result['trained']['n_rated']})"
    )
    print(
        f"trained - base: {result['diff']['score']:+.3f}  "
        f"95% CI [{result['diff']['ci95'][0]:+.3f}, {result['diff']['ci95'][1]:+.3f}]"
    )
    print(f"median ms per read: base={result['base']['median_ms']:.0f} trained={result['trained']['median_ms']:.0f}")
    print(f"verdict: {result['verdict']}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
