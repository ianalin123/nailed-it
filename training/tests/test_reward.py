import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from nailed_it_training.critic import CriticEstimate
from nailed_it_training.protocol import Read, ReadCategory
from nailed_it_training.reward import (
    Gate,
    RewardConfig,
    check_gates,
    deck_reward,
    expected_information_gain,
    information_gain,
    jaccard_similarity,
    score_read,
    share_deck_reward,
)
from nailed_it_training.verifier import VerdictLabel, VerifierVerdict

EPS = 0.01
unit = st.floats(min_value=0.0, max_value=1.0, allow_nan=False)


def make_read(
    read_id: str = "r1",
    text: str = "You write your best code after midnight.",
    category: ReadCategory = ReadCategory.WORK_STYLE,
    confidence: float = 0.7,
    evidence_ids: tuple[str, ...] = ("e1",),
    hops: int = 2,
) -> Read:
    return Read(
        id=read_id,
        text=text,
        category=category,
        confidence=confidence,
        evidenceIds=list(evidence_ids),
        hops=hops,
        modelVersion="test",
    )


def verdict(label: VerdictLabel, strength: float = 0.9, cited: tuple[str, ...] = ("h1",)) -> VerifierVerdict:
    cited_ids = [] if label is VerdictLabel.UNVERIFIABLE else list(cited)
    return VerifierVerdict(label=label, strength=strength, cited_ids=cited_ids, rationale="test")


class TestInformationGain:
    @given(b=st.floats(min_value=EPS, max_value=1 - EPS), y=st.sampled_from([0, 1]))
    def test_confidence_equal_to_base_rate_earns_zero(self, b: float, y: int) -> None:
        assert information_gain(b, y, b, EPS) == pytest.approx(0.0, abs=1e-12)

    def test_generic_read_near_base_rate_earns_about_zero_in_expectation(self) -> None:
        b = 0.93
        for c in (0.91, 0.93, 0.95):
            assert abs(expected_information_gain(c, b, b, EPS)) < 0.01

    @pytest.mark.parametrize("p", [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95])
    @pytest.mark.parametrize("b", [0.1, 0.5, 0.9])
    def test_honest_confidence_maximises_expected_reward(self, p: float, b: float) -> None:
        grid = [i / 1000 for i in range(10, 991)]
        best_c = max(grid, key=lambda c: expected_information_gain(c, p, b, EPS))
        assert best_c == pytest.approx(p, abs=1e-3)
        honest = expected_information_gain(p, p, b, EPS)
        assert all(honest >= expected_information_gain(c, p, b, EPS) - 1e-12 for c in grid)

    def test_expected_reward_at_honest_confidence_is_kl_and_nonnegative(self) -> None:
        p, b = 0.8, 0.3
        kl = p * math.log(p / b) + (1 - p) * math.log((1 - p) / (1 - b))
        assert expected_information_gain(p, p, b, EPS) == pytest.approx(kl)

    def test_confident_miss_is_strongly_negative(self) -> None:
        assert information_gain(0.95, 0, 0.5, EPS) < -2.0
        assert information_gain(1.0, 0, 0.5, EPS) < information_gain(0.95, 0, 0.5, EPS)

    def test_bold_correct_read_with_low_base_rate_beats_safe_correct_read(self) -> None:
        bold = information_gain(0.7, 1, 0.1, EPS)
        safe = information_gain(0.95, 1, 0.9, EPS)
        assert bold > safe > 0

    @given(c=unit, b=unit, y=st.sampled_from([0, 1]))
    def test_reward_is_finite_everywhere_including_endpoints(self, c: float, b: float, y: int) -> None:
        assert math.isfinite(information_gain(c, y, b, EPS))

    @pytest.mark.parametrize("c", [0.0, 1.0])
    @pytest.mark.parametrize("y", [0, 1])
    def test_endpoints_are_clipped_to_eps(self, c: float, y: int) -> None:
        clipped = min(max(c, EPS), 1 - EPS)
        assert information_gain(c, y, 0.5, EPS) == pytest.approx(information_gain(clipped, y, 0.5, EPS))

    @pytest.mark.parametrize(
        ("c", "y", "b", "eps"),
        [(1.2, 1, 0.5, EPS), (0.5, 2, 0.5, EPS), (0.5, 1, -0.1, EPS), (math.nan, 1, 0.5, EPS), (0.5, 1, 0.5, 0.0), (0.5, 1, 0.5, 0.5)],
    )
    def test_invalid_inputs_raise(self, c: float, y: int, b: float, eps: float) -> None:
        with pytest.raises(ValueError):
            information_gain(c, y, b, eps)


class TestGates:
    def test_passes_grounded_inference(self) -> None:
        assert check_gates(make_read(), visible_ids={"e1", "e2"}) is Gate.PASSED

    def test_self_reported_hops_zero_is_restatement(self) -> None:
        assert check_gates(make_read(hops=0), visible_ids={"e1"}) is Gate.RESTATEMENT

    def test_measured_entailment_is_restatement_even_if_hops_claimed(self) -> None:
        assert check_gates(make_read(hops=3), visible_ids={"e1"}, entailed_by_visible=True) is Gate.RESTATEMENT

    def test_citing_unknown_id_is_ungrounded(self) -> None:
        assert check_gates(make_read(evidence_ids=("e1", "hidden-7")), visible_ids={"e1"}) is Gate.UNGROUNDED

    def test_citing_nothing_is_ungrounded(self) -> None:
        assert check_gates(make_read(evidence_ids=()), visible_ids={"e1"}) is Gate.UNGROUNDED

    def test_ungrounded_takes_precedence_over_restatement(self) -> None:
        assert check_gates(make_read(hops=0, evidence_ids=("zz",)), visible_ids={"e1"}) is Gate.UNGROUNDED


class TestScoreRead:
    config = RewardConfig(eps=EPS)

    def test_supported_read_scores_information_gain_with_outcome_one(self) -> None:
        read = make_read(confidence=0.7)
        scored = score_read(read, visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED), base_rate=0.2, config=self.config)
        assert scored.reward == pytest.approx(information_gain(0.7, 1, 0.2, EPS))
        assert scored.outcome == 1

    def test_contradicted_read_scores_information_gain_with_outcome_zero(self) -> None:
        read = make_read(confidence=0.7)
        scored = score_read(read, visible_ids={"e1"}, verdict=verdict(VerdictLabel.CONTRADICTED), base_rate=0.2, config=self.config)
        assert scored.reward == pytest.approx(information_gain(0.7, 0, 0.2, EPS))
        assert scored.outcome == 0

    def test_weak_verdict_is_treated_as_unverifiable(self) -> None:
        scored = score_read(
            make_read(), visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED, strength=0.2), base_rate=0.2, config=self.config
        )
        assert scored.outcome is None
        assert scored.reward == 0.0

    def test_restatement_scores_zero(self) -> None:
        scored = score_read(make_read(hops=0), visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED), base_rate=0.2, config=self.config)
        assert scored.gate is Gate.RESTATEMENT
        assert scored.reward == 0.0

    def test_ungrounded_scores_the_configured_penalty(self) -> None:
        scored = score_read(
            make_read(evidence_ids=("nope",)), visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED), base_rate=0.2, config=self.config
        )
        assert scored.gate is Gate.UNGROUNDED
        assert scored.reward == self.config.ungrounded_penalty < 0

    def test_unverifiable_without_critic_scores_zero(self) -> None:
        scored = score_read(make_read(), visible_ids={"e1"}, verdict=verdict(VerdictLabel.UNVERIFIABLE), base_rate=0.2, config=self.config)
        assert scored.reward == 0.0
        assert scored.outcome is None

    def test_unverifiable_with_critic_is_expected_gain_scaled_by_certainty(self) -> None:
        critic = CriticEstimate(p_confirm=0.9, uncertainty=0.25)
        scored = score_read(
            make_read(confidence=0.8),
            visible_ids={"e1"},
            verdict=verdict(VerdictLabel.UNVERIFIABLE),
            base_rate=0.3,
            critic=critic,
            config=self.config,
        )
        assert scored.reward == pytest.approx(0.75 * expected_information_gain(0.8, 0.9, 0.3, EPS))


class TestDeckReward:
    config = RewardConfig(eps=EPS, redundancy_weight=1.0, coverage_weight=0.5)

    def test_total_is_sum_minus_redundancy_plus_coverage(self) -> None:
        reads = [
            make_read("a", "You sketch on paper first.", ReadCategory.WORK_STYLE),
            make_read("b", "You distrust frameworks.", ReadCategory.TECHNICAL_IDENTITY),
            make_read("c", "You call your sister weekly.", ReadCategory.PEOPLE_SOCIAL),
        ]
        result = deck_reward(reads, [1.0, 0.5, -0.25], self.config)
        assert result.read_sum == pytest.approx(1.25)
        assert result.total == pytest.approx(result.read_sum - result.redundancy + 0.5 * result.coverage)
        assert result.coverage == pytest.approx(1.0)

    def test_near_duplicate_reads_are_penalised_more_than_diverse_reads(self) -> None:
        dupes = [make_read(str(i), "You write your best code after midnight.") for i in range(4)]
        diverse = [
            make_read("a", "You write your best code after midnight."),
            make_read("b", "You keep a paper notebook for ideas."),
            make_read("c", "You avoid phone calls with strangers."),
            make_read("d", "You rewrite emails three times before sending."),
        ]
        rewards = [0.5] * 4
        assert deck_reward(dupes, rewards, self.config).redundancy > deck_reward(diverse, rewards, self.config).redundancy
        assert deck_reward(dupes, rewards, self.config).total < deck_reward(diverse, rewards, self.config).total

    def test_more_categories_earn_more_coverage(self) -> None:
        same = [make_read(str(i), f"Read number {i}.", ReadCategory.WORK_STYLE) for i in range(3)]
        mixed = [
            make_read("0", "Read number 0.", ReadCategory.WORK_STYLE),
            make_read("1", "Read number 1.", ReadCategory.TASTE_AESTHETICS),
            make_read("2", "Read number 2.", ReadCategory.LIFE_LOGISTICS),
        ]
        assert deck_reward(mixed, [0.0] * 3, self.config).coverage > deck_reward(same, [0.0] * 3, self.config).coverage

    def test_single_read_has_zero_redundancy(self) -> None:
        assert deck_reward([make_read()], [0.3], self.config).redundancy == 0.0

    def test_mismatched_lengths_raise(self) -> None:
        with pytest.raises(ValueError):
            deck_reward([make_read()], [0.3, 0.1], self.config)

    def test_share_splits_total_equally(self) -> None:
        result = deck_reward([make_read("a"), make_read("b", "Other text entirely here.")], [1.0, 1.0], self.config)
        assert share_deck_reward(result, 2) == pytest.approx([result.total / 2] * 2)

    def test_jaccard_similarity_bounds(self) -> None:
        assert jaccard_similarity("a b c", "a b c") == 1.0
        assert jaccard_similarity("a b", "c d") == 0.0
