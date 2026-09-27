"""Measured base rate of a read: how often it verifies on other people (spec Idea 2)."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from nailed_it_training.protocol import EvidenceItem
from nailed_it_training.verifier import VerdictLabel, Verifier


@dataclass(frozen=True)
class BaseRate:
    value: float
    hits: int
    decided: int
    unverifiable: int


def shrink(*, hits: int, decided: int, prior: float, prior_strength: float) -> float:
    """Beta-binomial posterior mean: (hits + k*prior) / (decided + k)."""
    if not 0.0 <= prior <= 1.0:
        raise ValueError(f"prior must be in [0, 1], got {prior}")
    if prior_strength < 0:
        raise ValueError(f"prior_strength must be non-negative, got {prior_strength}")
    if not 0 <= hits <= decided:
        raise ValueError(f"need 0 <= hits <= decided, got hits={hits} decided={decided}")
    if decided == 0 and prior_strength == 0:
        raise ValueError("no samples and zero prior strength leave the base rate undefined")
    return (hits + prior_strength * prior) / (decided + prior_strength)


def estimate_base_rate(
    read_text: str,
    hidden_by_person: Mapping[str, Sequence[EvidenceItem]],
    verifier: Verifier,
    *,
    exclude: str,
    prior: float = 0.5,
    prior_strength: float = 2.0,
) -> BaseRate:
    """Hit rate = supported / (supported + contradicted) over other people. Unverifiable verdicts are not samples."""
    hits = decided = unverifiable = 0
    for person_id, hidden in sorted(hidden_by_person.items()):
        if person_id == exclude or not hidden:
            continue
        label = verifier.verify(read_text, hidden).label
        if label is VerdictLabel.UNVERIFIABLE:
            unverifiable += 1
            continue
        decided += 1
        hits += label is VerdictLabel.SUPPORTED
    value = shrink(hits=hits, decided=decided, prior=prior, prior_strength=prior_strength)
    return BaseRate(value=value, hits=hits, decided=decided, unverifiable=unverifiable)
