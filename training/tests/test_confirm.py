import pytest

from nailed_it_training.confirm import DeckStat, deck_bootstrap_diff, deck_bootstrap_ratio, interleave, verdict


def decks(values: list[list[float]]) -> list[DeckStat]:
    return [DeckStat(numerator=sum(v), denominator=len(v)) for v in values]


def test_ratio_is_pooled_over_reads_not_averaged_over_decks() -> None:
    point, lo, hi = deck_bootstrap_ratio(decks([[1.0], [0.0, 0.0, 0.0]]), n_boot=500, seed=0)
    assert point == pytest.approx(0.25)
    assert lo <= point <= hi


def test_identical_arms_give_an_interval_containing_zero() -> None:
    arm = decks([[0.1, 0.4, 0.0], [0.3, 0.0], [0.2, 0.2, 0.5], [0.0, 0.1]] * 5)
    diff, lo, hi = deck_bootstrap_diff(arm, arm, n_boot=2000, seed=0)
    assert diff == pytest.approx(0.0)
    assert lo < 0.0 < hi


def test_clearly_better_arm_is_above_zero_and_seeded() -> None:
    a = decks([[1.0, 0.9, 1.1]] * 20)
    b = decks([[0.0, 0.1, -0.1]] * 20)
    first = deck_bootstrap_diff(a, b, n_boot=1000, seed=3)
    assert first == deck_bootstrap_diff(a, b, n_boot=1000, seed=3)
    assert first[1] > 0.0


def test_resampling_is_by_deck_so_one_huge_deck_widens_the_interval() -> None:
    many_small = decks([[0.5]] * 40)
    one_varying = decks([[2.0] * 20] + [[0.0]] * 39)
    _, lo_a, hi_a = deck_bootstrap_ratio(many_small, n_boot=1000, seed=0)
    _, lo_b, hi_b = deck_bootstrap_ratio(one_varying, n_boot=1000, seed=0)
    assert hi_b - lo_b > hi_a - lo_a


def test_verdict_rule() -> None:
    assert verdict(0.01, 0.2) == "confirmed"
    assert verdict(-0.01, 0.2) == "not confirmed"
    assert verdict(-0.3, -0.02) == "reversed"


def test_empty_arm_raises() -> None:
    with pytest.raises(ValueError):
        deck_bootstrap_ratio([], n_boot=10, seed=0)


def test_interleave_alternates_arms() -> None:
    assert interleave(["a1", "a2", "a3"], ["b1", "b2"]) == ["a1", "b1", "a2", "b2", "a3"]


def test_summarise_computes_every_metric_from_deck_records() -> None:
    from nailed_it_training.confirm import summarise

    def deck(rewards: list[tuple[float, int | None, str]], invalid: int = 0) -> dict:
        return {"n_invalid": invalid, "reads": [{"reward": r, "outcome": o, "gate": g} for r, o, g in rewards]}

    good = [deck([(1.0, 1, "passed"), (0.0, None, "passed"), (0.0, 1, "restatement")])] * 10
    weak = [deck([(0.0, None, "passed"), (-1.0, 0, "passed"), (0.0, None, "restatement")], invalid=1)] * 10
    out = summarise(good, weak)
    assert out["information_gain_per_read"]["step005"][0] == pytest.approx(1 / 3)
    assert out["information_gain_per_read"]["base"][0] == pytest.approx(-1 / 3)
    assert out["supported_share"]["step005"][0] == pytest.approx(2 / 3)
    assert out["restatement_rate"]["base"][0] == pytest.approx(1 / 3)
    assert out["unverifiable_share"]["step005"][0] == pytest.approx(1 / 2)
    assert out["invalid_read_rate"]["base"][0] == pytest.approx(1 / 4)
    assert out["information_gain_per_read"]["difference_step005_minus_base"][0] == pytest.approx(2 / 3)
