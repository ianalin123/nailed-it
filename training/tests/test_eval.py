import pytest

from nailed_it_training.eval import (
    ABLATION_ROWS,
    AblationRow,
    EvalMetrics,
    ScoredDeck,
    bootstrap_ci,
    compute_metrics,
    distinguishable,
    expected_calibration_error,
    read_information_gains,
    render_ablation_table,
)
from nailed_it_training.protocol import Read, ReadCategory
from nailed_it_training.reward import DeckReward, Gate, ScoredRead


def sr(confidence: float, outcome: int | None, gate: Gate = Gate.PASSED, reward: float = 0.0, rid: str = "r") -> ScoredRead:
    read = Read(id=rid, text="t", category=ReadCategory.WORK_STYLE, confidence=confidence, evidenceIds=["e"], hops=1, modelVersion="m")
    return ScoredRead(read=read, gate=gate, verdict=None, base_rate=0.5, critic=None, outcome=outcome, reward=reward)


def deck(reads: list[ScoredRead], redundancy: float = 0.2) -> ScoredDeck:
    return ScoredDeck(reads=tuple(reads), reward=DeckReward(read_mean=0.0, redundancy=redundancy, coverage=1.0, size_penalty=0.0, total=0.0))


def test_ece_is_zero_for_perfectly_calibrated_bins() -> None:
    reads = [sr(0.25, 1)] + [sr(0.25, 0)] * 3 + [sr(0.75, 1)] * 3 + [sr(0.75, 0)]
    assert expected_calibration_error(reads) == pytest.approx(0.0)


def test_ece_detects_overconfidence() -> None:
    reads = [sr(0.95, 0)] * 5 + [sr(0.95, 1)] * 5
    assert expected_calibration_error(reads) == pytest.approx(0.45)


def test_ece_is_none_without_decided_reads() -> None:
    assert expected_calibration_error([sr(0.5, None)]) is None


def test_compute_metrics() -> None:
    reads = [
        sr(0.8, 1, reward=0.4),
        sr(0.8, 0, reward=-1.2),
        sr(0.6, None),
        sr(0.9, None, gate=Gate.RESTATEMENT),
        sr(0.9, None, gate=Gate.UNGROUNDED, reward=-1.0),
    ]
    m = compute_metrics([deck(reads, 0.3), deck([sr(0.7, 1, reward=0.2)], 0.1)])
    assert m.n_reads == 6
    assert m.verified_accuracy == pytest.approx(2 / 3)
    assert m.mean_information_gain == pytest.approx((0.4 - 1.2 + 0.2) / 6)
    assert m.restatement_rate == pytest.approx(1 / 6)
    assert m.ungrounded_rate == pytest.approx(1 / 6)
    assert m.unverifiable_rate == pytest.approx(1 / 4)
    assert m.deck_redundancy == pytest.approx(0.2)


def test_compute_metrics_rejects_empty() -> None:
    with pytest.raises(ValueError):
        compute_metrics([])


def test_ablation_rows_match_spec_order() -> None:
    assert [r.label for r in ABLATION_ROWS] == [
        "Base model",
        "SFT on raw teacher output",
        "SFT + GRPO with correctness reward",
        "Verified distillation only (stage A)",
        "Full (A + B)",
    ]


def metrics(acc: float | None) -> EvalMetrics:
    return EvalMetrics(
        n_reads=10,
        verified_accuracy=acc,
        mean_information_gain=0.1,
        expected_calibration_error=0.05,
        restatement_rate=0.1,
        unverifiable_rate=0.2,
        ungrounded_rate=0.0,
        deck_redundancy=0.15,
    )


def test_renders_five_row_markdown_table() -> None:
    table = render_ablation_table({row: metrics(0.5) for row in AblationRow})
    lines = table.strip().splitlines()
    assert len(lines) == 2 + 5
    assert lines[0].startswith("| # | Model")
    assert "Full (A + B)" in lines[-1]


def test_renders_missing_metric_as_na() -> None:
    table = render_ablation_table({row: metrics(None) for row in AblationRow})
    assert "n/a" in table


def test_render_raises_when_a_row_is_missing() -> None:
    results = {row: metrics(0.5) for row in AblationRow if row is not AblationRow.FULL}
    with pytest.raises(ValueError, match="Full"):
        render_ablation_table(results)


class TestUncertainty:
    def test_bootstrap_interval_brackets_the_mean_and_is_deterministic(self) -> None:
        values = [0.0] * 50 + [1.0] * 50
        lo, hi = bootstrap_ci(values, n_boot=2000, seed=0)
        assert lo < 0.5 < hi
        assert (lo, hi) == bootstrap_ci(values, n_boot=2000, seed=0)
        assert lo > 0.35 and hi < 0.65

    def test_bootstrap_rejects_empty(self) -> None:
        with pytest.raises(ValueError):
            bootstrap_ci([], n_boot=10, seed=0)

    def test_distinguishable_only_when_intervals_do_not_overlap(self) -> None:
        assert distinguishable((0.1, 0.2), (0.25, 0.4))
        assert not distinguishable((0.1, 0.3), (0.25, 0.4))

    def test_metrics_carry_decided_count_and_ig_interval(self) -> None:
        reads = [sr(0.8, 1, reward=0.4), sr(0.8, 0, reward=-1.2), sr(0.6, None), sr(0.7, 1, reward=0.2)]
        m = compute_metrics([deck(reads)])
        assert m.n_decided == 3
        assert m.ig_ci_low is not None and m.ig_ci_high is not None
        assert m.ig_ci_low <= m.mean_information_gain <= m.ig_ci_high

    def test_read_gains_count_undecided_reads_as_zero(self) -> None:
        reads = [sr(0.8, 1, reward=0.4), sr(0.6, None, reward=0.0)]
        assert read_information_gains([deck(reads)]) == [0.4, 0.0]
