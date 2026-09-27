"""Choose game cards where a human label teaches the most (spec Idea 6).

Two layers. Across categories, Thompson sampling over Beta posteriors of "this category's labels
surprise the critic". Within the draw, cards are ranked by critic uncertainty plus a bonus when the
verifier could not decide. Only cards whose stated confidence sits in the fun band are eligible.
"""

import random
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

from nailed_it_training.critic import CriticEstimate, truth_to_target
from nailed_it_training.protocol import Read, ReadCategory, Truth
from nailed_it_training.verifier import VerdictLabel

CONFIDENCE_BAND = (0.45, 0.8)
UNDECIDED_BONUS = 0.5


class InsufficientCardsError(ValueError):
    pass


@dataclass(frozen=True)
class Candidate:
    read: Read
    critic: CriticEstimate
    verifier_label: VerdictLabel


@dataclass(frozen=True)
class BanditState:
    alpha: dict[ReadCategory, float] = field(default_factory=dict)
    beta: dict[ReadCategory, float] = field(default_factory=dict)

    @classmethod
    def uniform(cls) -> "BanditState":
        return cls(alpha={c: 1.0 for c in ReadCategory}, beta={c: 1.0 for c in ReadCategory})

    def mean(self, category: ReadCategory) -> float:
        a, b = self.alpha[category], self.beta[category]
        return a / (a + b)


def eligible(candidate: Candidate, band: tuple[float, float] = CONFIDENCE_BAND) -> bool:
    low, high = band
    return low <= candidate.read.confidence <= high


def priority(candidate: Candidate) -> float:
    bonus = UNDECIDED_BONUS if candidate.verifier_label is VerdictLabel.UNVERIFIABLE else 0.0
    return candidate.critic.uncertainty + bonus


def select_cards(
    candidates: Sequence[Candidate],
    k: int,
    state: BanditState,
    rng: random.Random,
    band: tuple[float, float] = CONFIDENCE_BAND,
) -> list[Candidate]:
    pool = [c for c in candidates if eligible(c, band)]
    if len(pool) < k:
        raise InsufficientCardsError(f"need {k} cards with confidence in {band}, only {len(pool)} of {len(candidates)} qualify")
    theta = {cat: rng.betavariate(state.alpha[cat], state.beta[cat]) for cat in ReadCategory}
    ranked = sorted(pool, key=lambda c: (-theta[c.read.category] * priority(c), c.read.id))
    return ranked[:k]


def update_state(state: BanditState, candidate: Candidate, truth: Truth) -> BanditState:
    """Bandit reward is critic surprise |label - P(confirm)|, a fractional Beta update."""
    surprise = abs(truth_to_target(truth) - candidate.critic.p_confirm)
    cat = candidate.read.category
    return replace(
        state,
        alpha={**state.alpha, cat: state.alpha[cat] + surprise},
        beta={**state.beta, cat: state.beta[cat] + (1.0 - surprise)},
    )
