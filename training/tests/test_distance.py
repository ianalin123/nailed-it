import pytest

from nailed_it_training.distance import DistanceConfig, containment, distance_weight, max_containment, needs_entailment_check, stemmed_tokens
from nailed_it_training.protocol import EvidenceItem, SourceKind

VISIBLE = [
    EvidenceItem(id="v1", source=SourceKind.GIT_HISTORY, text="Committed the parser fix at 2am again."),
    EvidenceItem(id="v2", source=SourceKind.CALENDAR, text="Declined the Monday standup, asked for a written update."),
]


def test_containment_is_share_of_read_content_words_found_in_an_item() -> None:
    assert containment("You committed the parser fix at 2am.", VISIBLE[0]) == pytest.approx(1.0)
    assert containment("You love sailing.", VISIBLE[0]) == 0.0


def test_max_containment_reports_the_closest_visible_item() -> None:
    score, item_id = max_containment("You skip the standup and ask for written updates.", VISIBLE)
    assert item_id == "v2" and score > 0.5


def test_weight_is_one_when_far_zero_when_close_and_smooth_between() -> None:
    config = DistanceConfig(weight_low=0.3, weight_high=0.7)
    assert distance_weight(0.1, config) == 1.0
    assert distance_weight(0.3, config) == 1.0
    assert distance_weight(0.7, config) == 0.0
    assert distance_weight(0.9, config) == 0.0
    mid = [distance_weight(0.3 + 0.04 * i, config) for i in range(11)]
    assert all(a >= b for a, b in zip(mid, mid[1:], strict=False))
    assert 0.0 < distance_weight(0.5, config) < 1.0


def test_entailment_band() -> None:
    config = DistanceConfig(check_low=0.05, check_high=0.7)
    assert not needs_entailment_check(0.01, config)
    assert needs_entailment_check(0.2, config)
    assert not needs_entailment_check(0.8, config)


def test_config_validation() -> None:
    with pytest.raises(ValueError):
        DistanceConfig(weight_low=0.8, weight_high=0.2)


@pytest.mark.parametrize(
    ("a", "b"), [("fixes", "fix"), ("pushes", "push"), ("updates", "update"), ("committed", "commit"), ("running", "run"), ("asked", "ask")]
)
def test_stemmer_merges_inflections(a: str, b: str) -> None:
    assert stemmed_tokens(a) == stemmed_tokens(b)
