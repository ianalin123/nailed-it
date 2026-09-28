"""Inferential distance of a read from the visible evidence (run-2 change A).

Similarity is containment: the share of the read's content words found in one visible item. The reward
weight is 1 at or below weight_low, 0 at or above weight_high, and falls smoothly between. Reads whose
similarity lies in the entailment band also get a verifier entailment check against the visible items; an
entailed read gets weight 0. Run 1's eval decks showed lexical overlap alone separates restatements poorly
(median containment 0.21 for entailment-gated reads vs 0.15 for the rest), so the band starts low.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from nailed_it_training.protocol import EvidenceItem
from nailed_it_training.verifier import _content_tokens


@dataclass(frozen=True)
class DistanceConfig:
    weight_low: float = 0.3
    weight_high: float = 0.7
    check_low: float = 0.05
    check_high: float = 0.7

    def __post_init__(self) -> None:
        if not 0.0 <= self.weight_low < self.weight_high <= 1.0:
            raise ValueError("need 0 <= weight_low < weight_high <= 1")
        if not 0.0 <= self.check_low <= self.check_high <= 1.0:
            raise ValueError("need 0 <= check_low <= check_high <= 1")


def _stem(word: str) -> str:
    """Tiny suffix stripper: fixes->fix, pushes->push, updates->update, committed->commit, running->run."""
    if len(word) > 4 and word.endswith("es") and word[-3] in "xsz" or word.endswith(("ches", "shes")):
        return word[:-2]
    for suffix in ("ing", "ed", "s"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix) and not word.endswith("ss"):
            stem = word[: -len(suffix)]
            if suffix != "s" and len(stem) > 3 and stem[-1] == stem[-2] and stem[-1] not in "aeiouls":
                stem = stem[:-1]
            return stem
    return word


def stemmed_tokens(text: str) -> frozenset[str]:
    return frozenset(_stem(w) for w in _content_tokens(text))


def containment(read_text: str, item: EvidenceItem) -> float:
    tokens = stemmed_tokens(read_text)
    if not tokens:
        return 0.0
    return len(tokens & stemmed_tokens(item.text)) / len(tokens)


def max_containment(read_text: str, visible: Sequence[EvidenceItem]) -> tuple[float, str | None]:
    best: tuple[float, str | None] = (0.0, None)
    for item in visible:
        score = containment(read_text, item)
        if score > best[0]:
            best = (score, item.id)
    return best


def distance_weight(similarity: float, config: DistanceConfig) -> float:
    if similarity <= config.weight_low:
        return 1.0
    if similarity >= config.weight_high:
        return 0.0
    x = (similarity - config.weight_low) / (config.weight_high - config.weight_low)
    return 1.0 - x * x * (3.0 - 2.0 * x)


def needs_entailment_check(similarity: float, config: DistanceConfig) -> bool:
    return config.check_low <= similarity < config.check_high
