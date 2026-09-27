"""Information-gain reward, gates, and deck-level reward (spec Ideas 2, 3, 4)."""

import math
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from enum import StrEnum
from itertools import combinations

from nailed_it_training.critic import CriticEstimate
from nailed_it_training.protocol import Read, ReadCategory
from nailed_it_training.verifier import VerdictLabel, VerifierVerdict

Similarity = Callable[[str, str], float]


class Gate(StrEnum):
    PASSED = "passed"
    RESTATEMENT = "restatement"
    UNGROUNDED = "ungrounded"


@dataclass(frozen=True)
class RewardConfig:
    eps: float = 0.01
    ungrounded_penalty: float = -1.0
    min_verdict_strength: float = 0.5
    redundancy_weight: float = 1.0
    coverage_weight: float = 0.5

    def __post_init__(self) -> None:
        _require_eps(self.eps)
        if not 0.0 <= self.min_verdict_strength <= 1.0:
            raise ValueError(f"min_verdict_strength must be in [0, 1], got {self.min_verdict_strength}")
        if self.redundancy_weight < 0 or self.coverage_weight < 0:
            raise ValueError("redundancy_weight and coverage_weight must be non-negative")


@dataclass(frozen=True)
class ScoredRead:
    read: Read
    gate: Gate
    verdict: VerifierVerdict | None
    base_rate: float | None
    critic: CriticEstimate | None
    outcome: int | None
    reward: float


@dataclass(frozen=True)
class DeckReward:
    read_sum: float
    redundancy: float
    coverage: float
    total: float


def _require_unit(name: str, value: float) -> None:
    if math.isnan(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be in [0, 1], got {value}")


def _require_eps(eps: float) -> None:
    if not 0.0 < eps < 0.5:
        raise ValueError(f"eps must be in (0, 0.5), got {eps}")


def _clip(p: float, eps: float) -> float:
    return min(max(p, eps), 1.0 - eps)


def log_score(p: float, y: float, eps: float) -> float:
    q = _clip(p, eps)
    return y * math.log(q) + (1.0 - y) * math.log(1.0 - q)


def information_gain(confidence: float, outcome: int, base_rate: float, eps: float) -> float:
    """R = [y log c + (1-y) log(1-c)] - [y log b + (1-y) log(1-b)], with c and b clipped to [eps, 1-eps]."""
    _require_unit("confidence", confidence)
    _require_unit("base_rate", base_rate)
    _require_eps(eps)
    if outcome not in (0, 1):
        raise ValueError(f"outcome must be 0 or 1, got {outcome}")
    return log_score(confidence, outcome, eps) - log_score(base_rate, outcome, eps)


def expected_information_gain(confidence: float, p_true: float, base_rate: float, eps: float) -> float:
    _require_unit("p_true", p_true)
    return p_true * information_gain(confidence, 1, base_rate, eps) + (1.0 - p_true) * information_gain(
        confidence, 0, base_rate, eps
    )


def check_gates(read: Read, visible_ids: Collection[str], entailed_by_visible: bool = False) -> Gate:
    if not read.evidence_ids or any(eid not in visible_ids for eid in read.evidence_ids):
        return Gate.UNGROUNDED
    if read.hops == 0 or entailed_by_visible:
        return Gate.RESTATEMENT
    return Gate.PASSED


def _decided_outcome(verdict: VerifierVerdict, min_strength: float) -> int | None:
    if verdict.strength < min_strength:
        return None
    match verdict.label:
        case VerdictLabel.SUPPORTED:
            return 1
        case VerdictLabel.CONTRADICTED:
            return 0
        case VerdictLabel.UNVERIFIABLE:
            return None


def score_read(
    read: Read,
    *,
    visible_ids: Collection[str],
    verdict: VerifierVerdict | None,
    base_rate: float | None,
    config: RewardConfig,
    entailed_by_visible: bool = False,
    critic: CriticEstimate | None = None,
) -> ScoredRead:
    gate = check_gates(read, visible_ids, entailed_by_visible)

    def result(outcome: int | None, reward: float) -> ScoredRead:
        return ScoredRead(read, gate, verdict, base_rate, critic, outcome, reward)

    if gate is Gate.UNGROUNDED:
        return result(None, config.ungrounded_penalty)
    if gate is Gate.RESTATEMENT:
        return result(None, 0.0)
    if verdict is None or base_rate is None:
        raise ValueError(f"read {read.id} passed the gates but has no verdict or base rate to score against")

    outcome = _decided_outcome(verdict, config.min_verdict_strength)
    if outcome is not None:
        return result(outcome, information_gain(read.confidence, outcome, base_rate, config.eps))
    if critic is None:
        return result(None, 0.0)
    certainty = 1.0 - critic.uncertainty
    return result(None, certainty * expected_information_gain(read.confidence, critic.p_confirm, base_rate, config.eps))


def _tokens(text: str) -> frozenset[str]:
    return frozenset("".join(ch if ch.isalnum() else " " for ch in text.lower()).split())


def jaccard_similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta and not tb:
        return 1.0
    return len(ta & tb) / len(ta | tb)


def mean_pairwise_similarity(texts: Sequence[str], similarity: Similarity = jaccard_similarity) -> float:
    pairs = list(combinations(texts, 2))
    if not pairs:
        return 0.0
    return sum(similarity(a, b) for a, b in pairs) / len(pairs)


def category_coverage(categories: Sequence[ReadCategory]) -> float:
    if not categories:
        return 0.0
    return len(set(categories)) / min(len(categories), len(ReadCategory))


def deck_reward(
    reads: Sequence[Read],
    read_rewards: Sequence[float],
    config: RewardConfig,
    similarity: Similarity = jaccard_similarity,
) -> DeckReward:
    if len(reads) != len(read_rewards):
        raise ValueError(f"got {len(reads)} reads but {len(read_rewards)} rewards")
    if not reads:
        raise ValueError("a deck needs at least one read")
    read_sum = float(sum(read_rewards))
    redundancy = mean_pairwise_similarity([r.text for r in reads], similarity)
    coverage = category_coverage([r.category for r in reads])
    total = read_sum - config.redundancy_weight * redundancy + config.coverage_weight * coverage
    return DeckReward(read_sum=read_sum, redundancy=redundancy, coverage=coverage, total=total)


def share_deck_reward(result: DeckReward, n_reads: int) -> list[float]:
    if n_reads < 1:
        raise ValueError("n_reads must be positive")
    return [result.total / n_reads] * n_reads
