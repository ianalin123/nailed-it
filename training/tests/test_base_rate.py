import pytest

from nailed_it_training.base_rate import BaseRate, estimate_base_rate, shrink
from nailed_it_training.protocol import EvidenceItem, SourceKind
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
