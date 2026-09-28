"""Frozen-benchmark metrics and the five-row ablation table (spec Eval)."""

import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum

from nailed_it_training.reward import DeckReward, Gate, ScoredRead


@dataclass(frozen=True)
class ScoredDeck:
    reads: tuple[ScoredRead, ...]
    reward: DeckReward
    n_invalid: int = 0


@dataclass(frozen=True)
class EvalMetrics:
    n_reads: int
    verified_accuracy: float | None
    mean_information_gain: float
    expected_calibration_error: float | None
    restatement_rate: float
    unverifiable_rate: float | None
    ungrounded_rate: float
    deck_redundancy: float
    n_malformed: int = 0
    n_invalid_reads: int = 0
    n_decided: int = 0
    ig_ci_low: float | None = None
    ig_ci_high: float | None = None
    mean_distance_weight: float | None = None


class AblationRow(Enum):
    BASE = "Base model"
    SFT_RAW = "SFT on raw teacher output"
    SFT_GRPO_CORRECTNESS = "SFT + GRPO with correctness reward"
    VERIFIED_DISTILLATION = "Verified distillation only (stage A)"
    FULL = "Full (A + B)"

    @property
    def label(self) -> str:
        return self.value


ABLATION_ROWS: tuple[AblationRow, ...] = tuple(AblationRow)


def expected_calibration_error(reads: Sequence[ScoredRead], n_bins: int = 10) -> float | None:
    decided = [r for r in reads if r.outcome is not None]
    if not decided:
        return None
    bins: list[list[ScoredRead]] = [[] for _ in range(n_bins)]
    for r in decided:
        bins[min(int(r.read.confidence * n_bins), n_bins - 1)].append(r)
    total = len(decided)
    return sum(
        len(b) / total * abs(sum(r.read.confidence for r in b) / len(b) - sum(r.outcome or 0 for r in b) / len(b)) for b in bins if b
    )


def bootstrap_ci(values: Sequence[float], *, n_boot: int = 2000, seed: int = 0, level: float = 0.95) -> tuple[float, float]:
    """Percentile bootstrap interval for the mean, resampling values with replacement."""
    if not values:
        raise ValueError("cannot bootstrap an empty sample")
    rng = random.Random(seed)
    n = len(values)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(n_boot))
    tail = (1.0 - level) / 2.0
    return means[int(tail * n_boot)], means[min(n_boot - 1, int((1.0 - tail) * n_boot))]


def distinguishable(a: tuple[float, float], b: tuple[float, float]) -> bool:
    """Report a difference only when the two intervals do not overlap."""
    return a[1] < b[0] or b[1] < a[0]


def read_information_gains(decks: Sequence["ScoredDeck"]) -> list[float]:
    """Per-read information gain as the metric defines it: the (weighted) reward of decided reads, 0 otherwise."""
    return [r.reward if r.outcome is not None else 0.0 for d in decks for r in d.reads]


def compute_metrics(decks: Sequence[ScoredDeck], n_malformed: int = 0) -> EvalMetrics:
    """Rates over all reads, except accuracy and ECE (decided reads) and unverifiable rate (reads that passed the gates).

    mean_information_gain divides by all reads: gated and unverifiable reads contribute zero gain.
    n_malformed counts completions that did not parse as a deck; they contribute no reads.
    """
    if not decks:
        raise ValueError("no decks to evaluate")
    reads = [r for d in decks for r in d.reads]
    n = len(reads)
    if n == 0:
        raise ValueError("no valid reads to evaluate")
    decided = [r for r in reads if r.outcome is not None]
    passed = [r for r in reads if r.gate is Gate.PASSED]
    ci = bootstrap_ci(read_information_gains(decks))
    return EvalMetrics(
        n_reads=n,
        verified_accuracy=sum(r.outcome or 0 for r in decided) / len(decided) if decided else None,
        mean_information_gain=sum(r.reward for r in decided) / n,
        expected_calibration_error=expected_calibration_error(reads),
        restatement_rate=sum(r.gate is Gate.RESTATEMENT for r in reads) / n,
        unverifiable_rate=sum(r.outcome is None for r in passed) / len(passed) if passed else None,
        ungrounded_rate=sum(r.gate is Gate.UNGROUNDED for r in reads) / n,
        deck_redundancy=sum(d.reward.redundancy for d in decks) / len(decks),
        n_malformed=n_malformed,
        n_invalid_reads=sum(d.n_invalid for d in decks),
        n_decided=len(decided),
        ig_ci_low=ci[0],
        ig_ci_high=ci[1],
        mean_distance_weight=sum(r.distance_weight for r in reads) / n,
    )


_COLUMNS: tuple[tuple[str, str], ...] = (
    ("Verified acc", "verified_accuracy"),
    ("Info gain / read", "mean_information_gain"),
    ("ECE", "expected_calibration_error"),
    ("Restatement", "restatement_rate"),
    ("Unverifiable", "unverifiable_rate"),
    ("Ungrounded", "ungrounded_rate"),
    ("Redundancy", "deck_redundancy"),
    ("Reads", "n_reads"),
    ("Malformed", "n_malformed"),
    ("Invalid reads", "n_invalid_reads"),
)


def _fmt(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, int):
        return str(value)
    return f"{value:.3f}"


def render_ablation_table(results: Mapping[AblationRow, EvalMetrics]) -> str:
    missing = [row.label for row in ABLATION_ROWS if row not in results]
    if missing:
        raise ValueError(f"ablation table is missing rows: {missing}")
    header = "| # | Model | " + " | ".join(name for name, _ in _COLUMNS) + " |"
    divider = "|---|---|" + "---|" * len(_COLUMNS)
    rows = [
        f"| {i} | {row.label} | " + " | ".join(_fmt(getattr(results[row], attr)) for _, attr in _COLUMNS) + " |"
        for i, row in enumerate(ABLATION_ROWS, start=1)
    ]
    return "\n".join([header, divider, *rows]) + "\n"
