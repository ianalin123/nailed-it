"""Information-gain reward, gates, and deck-level reward (spec Ideas 2, 3, 4)."""

import math
import re
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from enum import StrEnum
from itertools import combinations

from nailed_it_training.critic import CriticEstimate
from nailed_it_training.protocol import ChainKind, ChainStep, Read, ReadCategory
from nailed_it_training.verifier import VerdictLabel, VerifierVerdict

Similarity = Callable[[str, str], float]

DECK_SIZE = 12
ASSERTION_THRESHOLD = 0.5
_CHAIN_ID = re.compile(r"^\[([^\]\s]+)\]")


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
    deck_size: int = DECK_SIZE
    size_penalty: float = 0.25
    invalid_read_penalty: float = -1.0

    def __post_init__(self) -> None:
        _require_eps(self.eps)
        if not 0.0 <= self.min_verdict_strength <= 1.0:
            raise ValueError(f"min_verdict_strength must be in [0, 1], got {self.min_verdict_strength}")
        if self.redundancy_weight < 0 or self.coverage_weight < 0 or self.size_penalty < 0:
            raise ValueError("redundancy_weight, coverage_weight and size_penalty must be non-negative")
        if self.deck_size < 1:
            raise ValueError("deck_size must be positive")


@dataclass(frozen=True)
class ScoredRead:
    read: Read
    gate: Gate
    verdict: VerifierVerdict | None
    base_rate: float | None
    critic: CriticEstimate | None
    outcome: int | None
    reward: float
    distance_weight: float = 1.0


@dataclass(frozen=True)
class DeckReward:
    read_mean: float
    redundancy: float
    coverage: float
    size_penalty: float
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


def chain_evidence_id(step: ChainStep) -> str | None:
    """Evidence steps quote a visible item as "[<id>] <quote>". The protocol has no id field for this yet."""
    match = _CHAIN_ID.match(step.text)
    return match.group(1) if match else None


def _chain_grounded(chain: list[ChainStep], visible_ids: Collection[str]) -> bool:
    evidence = [step for step in chain if step.kind is ChainKind.EVIDENCE]
    if not evidence:
        return False
    return all((eid := chain_evidence_id(step)) is not None and eid in visible_ids for step in evidence)


def check_gates(read: Read, visible_ids: Collection[str]) -> Gate:
    """Grounding is the only hard gate. Restatement is a distance weight (see score_read); hops is ignored."""
    if not read.evidence_ids or any(eid not in visible_ids for eid in read.evidence_ids):
        return Gate.UNGROUNDED
    if read.chain is not None and not _chain_grounded(read.chain, visible_ids):
        return Gate.UNGROUNDED
    return Gate.PASSED


def assertion_floor(confidence: float, reward: float) -> float:
    """A read is an assertion: below 0.5 confidence it can lose but never win."""
    return min(reward, 0.0) if confidence < ASSERTION_THRESHOLD else reward


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
    distance_weight: float = 1.0,
    critic: CriticEstimate | None = None,
) -> ScoredRead:
    """Positive reward is multiplied by the distance weight; negative reward is not (a wrong restatement is still wrong).
    A read with weight 0 is labelled RESTATEMENT."""
    if not 0.0 <= distance_weight <= 1.0:
        raise ValueError(f"distance_weight must be in [0, 1], got {distance_weight}")
    if check_gates(read, visible_ids) is Gate.UNGROUNDED:
        return ScoredRead(read, Gate.UNGROUNDED, verdict, base_rate, critic, None, config.ungrounded_penalty, distance_weight)
    if verdict is None or base_rate is None:
        raise ValueError(f"read {read.id} passed the gates but has no verdict or base rate to score against")
    gate = Gate.RESTATEMENT if distance_weight == 0.0 else Gate.PASSED
    outcome = _decided_outcome(verdict, config.min_verdict_strength)
    if outcome is not None:
        raw = assertion_floor(read.confidence, information_gain(read.confidence, outcome, base_rate, config.eps))
    elif critic is not None:
        certainty = 1.0 - critic.uncertainty
        raw = assertion_floor(read.confidence, certainty * expected_information_gain(read.confidence, critic.p_confirm, base_rate, config.eps))
    else:
        raw = 0.0
    reward = raw * distance_weight if raw > 0 else raw
    return ScoredRead(read, gate, verdict, base_rate, critic, outcome, reward, distance_weight)


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
    n_invalid: int = 0,
) -> DeckReward:
    """Invalid reads (schema violations) each score invalid_read_penalty and count toward deck size."""
    if len(reads) != len(read_rewards):
        raise ValueError(f"got {len(reads)} reads but {len(read_rewards)} rewards")
    if n_invalid < 0:
        raise ValueError("n_invalid must be non-negative")
    n_total = len(reads) + n_invalid
    if n_total == 0:
        raise ValueError("a deck needs at least one read")
    read_mean = (float(sum(read_rewards)) + n_invalid * config.invalid_read_penalty) / n_total
    redundancy = mean_pairwise_similarity([r.text for r in reads], similarity)
    coverage = category_coverage([r.category for r in reads])
    size_penalty = config.size_penalty * abs(n_total - config.deck_size)
    total = read_mean - config.redundancy_weight * redundancy + config.coverage_weight * coverage - size_penalty
    return DeckReward(read_mean=read_mean, redundancy=redundancy, coverage=coverage, size_penalty=size_penalty, total=total)


def share_deck_reward(result: DeckReward, n_reads: int) -> list[float]:
    if n_reads < 1:
        raise ValueError("n_reads must be positive")
    return [result.total / n_reads] * n_reads
