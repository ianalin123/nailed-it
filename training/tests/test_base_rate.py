import json

import pytest

from nailed_it_training.base_rate import (
    BaseRate,
    CachingJudge,
    CategoryShrunkBaseRate,
    JudgeResponseError,
    LlmBaseRateJudge,
    PopulationBaseRate,
    estimate_base_rate,
    shrink,
)
from nailed_it_training.protocol import EvidenceItem, Read, ReadCategory, SourceKind
from nailed_it_training.reward import expected_information_gain, information_gain
from nailed_it_training.verifier import KeywordVerifier, TraitRule

RULES = [TraitRule(read_phrase="night owl", support_phrases=("up at 3am",), contradict_phrases=("asleep by 9",))]


def person(text: str) -> list[EvidenceItem]:
    return [EvidenceItem(id=f"{text[:3]}-1", source=SourceKind.OTHER, text=text)]


def test_no_decided_samples_returns_prior() -> None:
    result = estimate_base_rate("You are a night owl.", {"p1": person("likes tea")}, KeywordVerifier(RULES), exclude="me")
    assert result == BaseRate(value=0.5, hits=0, decided=0, unverifiable=1)


def test_shrinks_toward_prior_more_with_fewer_samples() -> None:
    assert shrink(hits=2, decided=2, prior=0.5, prior_strength=2.0) == pytest.approx(0.75)
    assert shrink(hits=50, decided=50, prior=0.5, prior_strength=2.0) == pytest.approx(51 / 52)
    assert shrink(hits=0, decided=0, prior=0.5, prior_strength=2.0) == 0.5


def test_counts_hits_over_decided_and_excludes_subject() -> None:
    others = {
        "me": person("up at 3am"),
        "a": person("up at 3am"),
        "b": person("up at 3am"),
        "c": person("asleep by 9"),
        "d": person("likes tea"),
    }
    result = estimate_base_rate("You are a night owl.", others, KeywordVerifier(RULES), exclude="me", prior_strength=2.0)
    assert (result.hits, result.decided, result.unverifiable) == (2, 3, 1)
    assert result.value == pytest.approx((2 + 1) / (3 + 2))


def test_people_with_no_hidden_evidence_are_skipped() -> None:
    result = estimate_base_rate("night owl", {"a": [], "b": person("up at 3am")}, KeywordVerifier(RULES), exclude="me")
    assert result.decided == 1


@pytest.mark.parametrize(("prior", "strength"), [(1.5, 2.0), (-0.1, 2.0), (0.5, -1.0)])
def test_invalid_prior_raises(prior: float, strength: float) -> None:
    with pytest.raises(ValueError):
        shrink(hits=1, decided=1, prior=prior, prior_strength=strength)


class FixedJudge:
    def __init__(self, values: dict[str, float]) -> None:
        self.values = values
        self.calls = 0

    def judge_many(self, reads: list[tuple[str, ReadCategory]]) -> list[float]:
        self.calls += 1
        return [self.values[text] for text, _ in reads]


def read(text: str, category: ReadCategory = ReadCategory.AMBITION_PSYCHOLOGY, confidence: float = 0.9) -> Read:
    return Read(id=text[:8], text=text, category=category, confidence=confidence, evidence_ids=["e1"], hops=1, model_version="m")


class TestCategoryShrunkBaseRate:
    def test_vague_read_with_high_judged_base_rate_earns_about_zero_at_matching_confidence(self) -> None:
        judge = FixedJudge({"You sometimes doubt yourself.": 0.95, "You want to do good work.": 0.9})
        source = CategoryShrunkBaseRate(judge, judge_weight=4.0, category_weight=1.0)
        source.base_rates([read("You want to do good work.")], subject="p")
        [b] = source.base_rates([read("You sometimes doubt yourself.")], subject="p")
        assert b == pytest.approx((4 * 0.95 + 0.9) / 5)
        c = 0.95
        assert abs(expected_information_gain(c, c, b, 0.01)) < 0.01
        assert information_gain(c, 1, b, 0.01) < 0.05

    def test_shrinks_toward_category_mean_not_one_half(self) -> None:
        judge = FixedJudge({"a": 0.9, "b": 0.9, "rare": 0.1})
        source = CategoryShrunkBaseRate(judge, judge_weight=1.0, category_weight=1.0)
        source.base_rates([read("a"), read("b")], subject="p")
        [b] = source.base_rates([read("rare")], subject="p")
        assert b == pytest.approx(0.5 * 0.1 + 0.5 * 0.9)
        assert source.category_mean(ReadCategory.AMBITION_PSYCHOLOGY) == pytest.approx((0.9 + 0.9 + 0.1) / 3)

    def test_first_read_in_a_category_is_not_shrunk(self) -> None:
        source = CategoryShrunkBaseRate(FixedJudge({"x": 0.2}))
        assert source.base_rates([read("x", ReadCategory.RISKY_READ)], subject="p") == [pytest.approx(0.2)]

    def test_bold_correct_read_still_pays(self) -> None:
        source = CategoryShrunkBaseRate(FixedJudge({"bold": 0.08}))
        [b] = source.base_rates([read("bold", ReadCategory.RISKY_READ)], subject="p")
        assert information_gain(0.7, 1, b, 0.01) > 1.5


class ScriptedClient:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.reply


class TestLlmBaseRateJudge:
    def test_batches_claims_and_sees_no_evidence(self) -> None:
        client = ScriptedClient(json.dumps({"estimates": [{"claim": "c0", "baseRate": 0.8}, {"claim": "c1", "baseRate": 0.1}]}))
        judge = LlmBaseRateJudge(client, population="adults who write software")
        claims = [("You doubt yourself.", ReadCategory.AMBITION_PSYCHOLOGY), ("You own a llama.", ReadCategory.RISKY_READ)]
        assert judge.judge_many(claims) == [0.8, 0.1]
        system, user = client.calls[0]
        assert "adults who write software" in system
        assert "evidence" not in user.lower()
        assert judge.stats.calls == 1 and judge.stats.items == 2

    @pytest.mark.parametrize(
        "raw",
        ["nope", json.dumps({"estimates": [{"claim": "c0", "baseRate": 1.4}]}), json.dumps({"estimates": [{"claim": "c9", "baseRate": 0.4}]})],
    )
    def test_bad_responses_raise(self, raw: str) -> None:
        with pytest.raises(JudgeResponseError):
            LlmBaseRateJudge(ScriptedClient(raw)).judge_many([("x", ReadCategory.WORK_STYLE)])

    def test_caching_judge_calls_inner_once_per_text(self) -> None:
        inner = FixedJudge({"a": 0.3, "b": 0.6})
        cached = CachingJudge(inner)
        assert cached.judge_many([("a", ReadCategory.WORK_STYLE), ("b", ReadCategory.WORK_STYLE)]) == [0.3, 0.6]
        assert cached.judge_many([("b", ReadCategory.WORK_STYLE), ("a", ReadCategory.WORK_STYLE)]) == [0.6, 0.3]
        assert inner.calls == 1
        assert cached.stats.hits == 2 and cached.stats.misses == 2


def test_population_base_rate_remains_available() -> None:
    source = PopulationBaseRate(KeywordVerifier(RULES), {"a": person("up at 3am"), "b": person("asleep by 9")}, prior_strength=2.0)
    assert source.base_rates([read("You are a night owl.")], subject="me") == [pytest.approx((1 + 1) / (2 + 2))]
