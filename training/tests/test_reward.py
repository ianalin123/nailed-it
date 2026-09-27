import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from nailed_it_training.critic import CriticEstimate
from nailed_it_training.protocol import ChainKind, ChainStep, Read, ReadCategory
from nailed_it_training.reward import (
    Gate,
    RewardConfig,
    chain_evidence_id,
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
    chain: list[ChainStep] | None = None,
) -> Read:
    return Read(
        id=read_id,
        text=text,
        category=category,
        confidence=confidence,
        evidence_ids=list(evidence_ids),
        hops=hops,
        model_version="test",
        chain=chain,
    )


def evidence_step(item_id: str, quote: str) -> ChainStep:
    return ChainStep(kind=ChainKind.EVIDENCE, text=f"[{item_id}] {quote}")


def inference_step(text: str) -> ChainStep:
    return ChainStep(kind=ChainKind.INFERENCE, text=text)


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

    def test_entailment_by_visible_is_restatement(self) -> None:
        assert check_gates(make_read(hops=3), visible_ids={"e1"}, entailed_by_visible=True) is Gate.RESTATEMENT

    def test_lying_hops_does_not_evade_the_gate(self) -> None:
        assert check_gates(make_read(hops=5), visible_ids={"e1"}, entailed_by_visible=True) is Gate.RESTATEMENT

    def test_self_reported_hops_zero_alone_is_not_a_gate(self) -> None:
        assert check_gates(make_read(hops=0), visible_ids={"e1"}, entailed_by_visible=False) is Gate.PASSED

    def test_citing_unknown_id_is_ungrounded(self) -> None:
        assert check_gates(make_read(evidence_ids=("e1", "hidden-7")), visible_ids={"e1"}) is Gate.UNGROUNDED

    def test_citing_nothing_is_ungrounded(self) -> None:
        assert check_gates(make_read(evidence_ids=()), visible_ids={"e1"}) is Gate.UNGROUNDED

    def test_ungrounded_takes_precedence_over_restatement(self) -> None:
        assert check_gates(make_read(evidence_ids=("zz",)), visible_ids={"e1"}, entailed_by_visible=True) is Gate.UNGROUNDED

    def test_chain_evidence_step_must_quote_a_visible_id(self) -> None:
        good = make_read(chain=[evidence_step("e1", "Committed at 02:14."), inference_step("Works late.")])
        assert check_gates(good, visible_ids={"e1"}) is Gate.PASSED
        hidden_quote = make_read(chain=[evidence_step("h9", "Pushed at 03:10."), inference_step("Works late.")])
        assert check_gates(hidden_quote, visible_ids={"e1"}) is Gate.UNGROUNDED
        no_id = make_read(chain=[ChainStep(kind=ChainKind.EVIDENCE, text="Committed late."), inference_step("Works late.")])
        assert check_gates(no_id, visible_ids={"e1"}) is Gate.UNGROUNDED

    def test_chain_with_only_inference_steps_is_ungrounded(self) -> None:
        assert check_gates(make_read(chain=[inference_step("Vibes.")]), visible_ids={"e1"}) is Gate.UNGROUNDED

    def test_chain_evidence_id_parsing(self) -> None:
        assert chain_evidence_id(evidence_step("abc-1", "x")) == "abc-1"
        assert chain_evidence_id(ChainStep(kind=ChainKind.EVIDENCE, text="no id here")) is None


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
        scored = score_read(
            make_read(), visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED), base_rate=0.2, config=self.config, entailed_by_visible=True
        )
        assert scored.gate is Gate.RESTATEMENT
        assert scored.reward == 0.0

    def test_ungrounded_scores_the_configured_penalty(self) -> None:
        scored = score_read(
            make_read(evidence_ids=("nope",)), visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED), base_rate=0.2, config=self.config
        )
        assert scored.gate is Gate.UNGROUNDED
        assert scored.reward == self.config.ungrounded_penalty < 0

    def test_assertion_floor_low_confidence_can_never_earn_positive_reward(self) -> None:
        read = make_read(confidence=0.3)
        assert information_gain(0.3, 0, 0.6, EPS) > 0
        scored = score_read(read, visible_ids={"e1"}, verdict=verdict(VerdictLabel.CONTRADICTED), base_rate=0.6, config=self.config)
        assert scored.reward == 0.0
        hit = score_read(read, visible_ids={"e1"}, verdict=verdict(VerdictLabel.SUPPORTED), base_rate=0.6, config=self.config)
        assert hit.reward == pytest.approx(information_gain(0.3, 1, 0.6, EPS))
        assert hit.reward < 0

    @given(c=st.floats(min_value=0.0, max_value=0.4999), b=unit, label=st.sampled_from([VerdictLabel.SUPPORTED, VerdictLabel.CONTRADICTED]))
    def test_assertion_floor_holds_everywhere(self, c: float, b: float, label: VerdictLabel) -> None:
        scored = score_read(make_read(confidence=c), visible_ids={"e1"}, verdict=verdict(label), base_rate=b, config=self.config)
        assert scored.reward <= 0.0

    def test_assertion_floor_applies_to_critic_scored_reads(self) -> None:
        critic = CriticEstimate(p_confirm=0.05, uncertainty=0.1)
        scored = score_read(
            make_read(confidence=0.2),
            visible_ids={"e1"},
            verdict=verdict(VerdictLabel.UNVERIFIABLE),
            base_rate=0.7,
            critic=critic,
            config=self.config,
        )
        assert scored.reward <= 0.0

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


def distinct_reads(n: int) -> list[Read]:
    words = [f"w{i}a w{i}b w{i}c" for i in range(n)]
    cats = list(ReadCategory)
    return [make_read(str(i), f"You {words[i]}.", cats[i % len(cats)]) for i in range(n)]


class TestDeckReward:
    config = RewardConfig(eps=EPS, redundancy_weight=1.0, coverage_weight=0.5, deck_size=12, size_penalty=0.25)

    def test_total_is_mean_minus_redundancy_plus_coverage_at_target_size(self) -> None:
        reads = distinct_reads(12)
        rewards = [0.1 * i for i in range(12)]
        result = deck_reward(reads, rewards, self.config)
        assert result.read_mean == pytest.approx(sum(rewards) / 12)
        assert result.size_penalty == 0.0
        assert result.total == pytest.approx(result.read_mean - result.redundancy + 0.5 * result.coverage)

    def test_reward_does_not_grow_with_deck_length(self) -> None:
        totals = {n: deck_reward(distinct_reads(n), [0.8] * n, self.config).total for n in range(3, 31)}
        assert max(totals, key=totals.__getitem__) == 12
        assert totals[24] < totals[12]
        assert totals[30] < totals[12]

    def test_short_decks_are_penalised_not_rescaled(self) -> None:
        short = deck_reward(distinct_reads(6), [0.8] * 6, self.config)
        assert short.size_penalty == pytest.approx(0.25 * 6)
        assert short.total < deck_reward(distinct_reads(12), [0.8] * 12, self.config).total

    def test_near_duplicate_reads_are_penalised_more_than_diverse_reads(self) -> None:
        dupes = [make_read(str(i), "You write your best code after midnight.") for i in range(12)]
        diverse = distinct_reads(12)
        rewards = [0.5] * 12
        assert deck_reward(dupes, rewards, self.config).redundancy > deck_reward(diverse, rewards, self.config).redundancy
        assert deck_reward(dupes, rewards, self.config).total < deck_reward(diverse, rewards, self.config).total

    def test_more_categories_earn_more_coverage(self) -> None:
        same = [make_read(str(i), f"Read number {i}.", ReadCategory.WORK_STYLE) for i in range(12)]
        assert deck_reward(distinct_reads(12), [0.0] * 12, self.config).coverage > deck_reward(same, [0.0] * 12, self.config).coverage

    def test_single_read_has_zero_redundancy(self) -> None:
        assert deck_reward([make_read()], [0.3], self.config).redundancy == 0.0

    def test_mismatched_lengths_raise(self) -> None:
        with pytest.raises(ValueError):
            deck_reward([make_read()], [0.3, 0.1], self.config)

    def test_share_splits_total_equally(self) -> None:
        result = deck_reward(distinct_reads(12), [1.0] * 12, self.config)
        assert share_deck_reward(result, 12) == pytest.approx([result.total / 12] * 12)

    def test_jaccard_similarity_bounds(self) -> None:
        assert jaccard_similarity("a b c", "a b c") == 1.0
        assert jaccard_similarity("a b", "c d") == 0.0
