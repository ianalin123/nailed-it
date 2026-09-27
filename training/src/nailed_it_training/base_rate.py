"""Base rate of a read: how often it is true of a person from the same broad population (spec Idea 2, amendment 1).

Default: a judge model estimates it with no evidence, shrunk toward the running mean of the read's
category. Alternative: the measured hit rate on other people's evidence (needs a real population).
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, Field, ValidationError

from nailed_it_training.protocol import EvidenceItem, Read, ReadCategory
from nailed_it_training.verifier import CacheStats, CallStats, LlmClient, VerdictLabel, Verifier, extract_json, text_hash

DEFAULT_POPULATION = "adults who work in or around software and use AI tools regularly"


class JudgeResponseError(ValueError):
    pass


class BaseRateJudge(Protocol):
    def judge_many(self, reads: Sequence[tuple[str, ReadCategory]]) -> list[float]: ...


class BaseRateSource(Protocol):
    def base_rates(self, reads: Sequence[Read], subject: str) -> list[float]: ...


JUDGE_SYSTEM_PROMPT = """You estimate base rates. For each claim written about an unnamed person, estimate the
probability that it is true of a person drawn at random from this population: {population}.

You know nothing about the specific person. Do not assume anything beyond membership in the population.
A claim true of almost everyone ("you sometimes doubt yourself") gets a high number. A specific,
unusual claim gets a low number.

Reply with a single JSON object and nothing else, one estimate per claim id:
{{"estimates": [{{"claim": "c0", "baseRate": <0..1>}}]}}"""


class _Estimate(BaseModel):
    claim: str
    baseRate: float = Field(ge=0.0, le=1.0)  # noqa: N815


class _EstimateBatch(BaseModel):
    estimates: list[_Estimate]


def parse_estimates(raw: str, n_claims: int) -> list[float]:
    try:
        batch = _EstimateBatch.model_validate_json(extract_json(raw))
    except ValidationError as err:
        raise JudgeResponseError(f"base-rate judge returned an invalid batch: {err}") from err
    by_claim = {e.claim: e.baseRate for e in batch.estimates}
    expected = [f"c{i}" for i in range(n_claims)]
    if sorted(by_claim) != sorted(expected) or len(by_claim) != len(batch.estimates):
        raise JudgeResponseError(f"judge claims mismatch: expected {expected}, got {[e.claim for e in batch.estimates]}")
    return [by_claim[c] for c in expected]


class LlmBaseRateJudge:
    def __init__(self, client: LlmClient, population: str = DEFAULT_POPULATION, batch_size: int = 12) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        self._client = client
        self._system = JUDGE_SYSTEM_PROMPT.format(population=population)
        self._batch_size = batch_size
        self.stats = CallStats()

    def judge_many(self, reads: Sequence[tuple[str, ReadCategory]]) -> list[float]:
        out: list[float] = []
        for start in range(0, len(reads), self._batch_size):
            chunk = reads[start : start + self._batch_size]
            claims = [{"claim": f"c{i}", "text": text} for i, (text, _) in enumerate(chunk)]
            raw = self._client.complete(self._system, f"Claims (JSON):\n{json.dumps(claims, ensure_ascii=False, indent=1)}")
            self.stats.calls += 1
            self.stats.items += len(chunk)
            out.extend(parse_estimates(raw, len(chunk)))
        return out


class CachingJudge:
    """Memoises by read-text hash (the judge sees no evidence, so the evidence-set key is constant)."""

    def __init__(self, inner: BaseRateJudge) -> None:
        self._inner = inner
        self._cache: dict[str, float] = {}
        self.stats = CacheStats()

    def judge_many(self, reads: Sequence[tuple[str, ReadCategory]]) -> list[float]:
        misses = list({text_hash(t): (t, c) for t, c in reads if text_hash(t) not in self._cache}.values())
        self.stats.hits += len(reads) - len(misses)
        self.stats.misses += len(misses)
        if misses:
            for (text, _), value in zip(misses, self._inner.judge_many(misses), strict=True):
                self._cache[text_hash(text)] = value
        return [self._cache[text_hash(t)] for t, _ in reads]


class CategoryShrunkBaseRate:
    """b = (w_j * judged + w_c * category_mean) / (w_j + w_c), with category_mean the running mean of prior judgements.

    The first read seen in a category is not shrunk. Judgements update the running mean after use,
    so results depend on the order reads are scored in.
    """

    def __init__(self, judge: BaseRateJudge, judge_weight: float = 4.0, category_weight: float = 1.0) -> None:
        if judge_weight <= 0 or category_weight < 0:
            raise ValueError("judge_weight must be positive and category_weight non-negative")
        self._judge = judge
        self._wj = judge_weight
        self._wc = category_weight
        self._sums: dict[ReadCategory, float] = {}
        self._counts: dict[ReadCategory, int] = {}

    def category_mean(self, category: ReadCategory) -> float | None:
        n = self._counts.get(category, 0)
        return self._sums[category] / n if n else None

    def base_rates(self, reads: Sequence[Read], subject: str) -> list[float]:
        judged = self._judge.judge_many([(r.text, r.category) for r in reads])
        out: list[float] = []
        for read, value in zip(reads, judged, strict=True):
            mean = self.category_mean(read.category)
            out.append(value if mean is None else (self._wj * value + self._wc * mean) / (self._wj + self._wc))
            self._sums[read.category] = self._sums.get(read.category, 0.0) + value
            self._counts[read.category] = self._counts.get(read.category, 0) + 1
        return out


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


class PopulationBaseRate:
    """Alternative source for when a real population of other people's evidence exists."""

    def __init__(
        self,
        verifier: Verifier,
        hidden_by_person: Mapping[str, Sequence[EvidenceItem]],
        prior: float = 0.5,
        prior_strength: float = 2.0,
    ) -> None:
        self._verifier = verifier
        self._population = hidden_by_person
        self._prior = prior
        self._strength = prior_strength

    def base_rates(self, reads: Sequence[Read], subject: str) -> list[float]:
        return [
            estimate_base_rate(r.text, self._population, self._verifier, exclude=subject, prior=self._prior, prior_strength=self._strength).value
            for r in reads
        ]
