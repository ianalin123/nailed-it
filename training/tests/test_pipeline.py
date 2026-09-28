import math
from dataclasses import replace
from pathlib import Path

import pytest

from nailed_it_training.base_rate import CategoryShrunkBaseRate
from nailed_it_training.cli import main
from nailed_it_training.episodes import SplitConfig, build_episodes
from nailed_it_training.eval import ABLATION_ROWS, AblationRow
from nailed_it_training.fake_backend import FakeBackend
from nailed_it_training.pipeline import (
    BenchmarkLeakageError,
    BenchmarkTamperedError,
    PipelineConfig,
    StageAStarvedError,
    VerifierDistrustedError,
    assert_no_leakage,
    freeze_benchmark,
    hold_out_time_window,
    run_pipeline,
    split_digests,
    verify_frozen,
)
from nailed_it_training.reward import Gate
from nailed_it_training.synthetic import LexiconJudge, generate_personas, keyword_rules, synthetic_verdicts
from nailed_it_training.verifier import CachingVerifier, KeywordVerifier

PEOPLE = generate_personas(10, seed=0)
DIGESTS = [p.digest for p in PEOPLE]
HELD_OUT = frozenset(d.digest_id for d in DIGESTS[8:])
SMALL = PipelineConfig(
    seed=0, heldout_digest_ids=HELD_OUT, rl_steps=6, sft_steps=5, group_size=4, groups_per_step=4, teacher_decks_per_episode=8
)


def run(config: PipelineConfig = SMALL, verdicts=None, digests=DIGESTS, verifier=None):
    return run_pipeline(
        FakeBackend(seed=config.seed),
        verifier or KeywordVerifier(keyword_rules()),
        CategoryShrunkBaseRate(LexiconJudge()),
        digests,
        config,
        verdicts=verdicts,
    )


@pytest.fixture(scope="module")
def result():
    return run()


def test_produces_all_five_rows_with_finite_metrics(result) -> None:
    assert set(result.metrics) == set(ABLATION_ROWS)
    for metrics in result.metrics.values():
        assert metrics.n_reads > 0
        assert math.isfinite(metrics.mean_information_gain)
    assert len(result.table.strip().splitlines()) == 7


def test_stage_a_keeps_only_positive_reward_reads_that_pass_gates(result) -> None:
    assert result.stage_a.survivors
    assert all(r.gate is Gate.PASSED and r.outcome is not None and r.reward > 0 for r in result.stage_a.survivors)
    assert result.stage_a.n_teacher_reads > len(result.stage_a.survivors)


def test_pipeline_is_deterministic(result) -> None:
    assert run().table == result.table


def test_rl_reward_history_recorded_for_both_rl_rows(result) -> None:
    assert set(result.reward_history) == {AblationRow.SFT_GRPO_CORRECTNESS, AblationRow.FULL}
    assert all(len(h) == SMALL.rl_steps for h in result.reward_history.values())


def test_benchmark_people_never_enter_training(result) -> None:
    assert not result.benchmark_digest_ids & result.training_digest_ids


def test_audit_stop_halts_training() -> None:
    bad = synthetic_verdicts(PEOPLE[:8], reads_per_person=12, seed=1, flip_rate=0.9, partly_rate=0.0)
    with pytest.raises(VerifierDistrustedError):
        run(verdicts=bad)


def test_audit_ok_trains_with_critic() -> None:
    good = synthetic_verdicts(PEOPLE[:8], reads_per_person=6, seed=1, flip_rate=0.0, partly_rate=0.05)
    out = run(verdicts=good)
    assert out.audit is not None and out.audit.agreement is not None and out.audit.agreement >= 0.75
    assert out.critic_trained


def test_require_audit_without_verdicts_raises() -> None:
    with pytest.raises(VerifierDistrustedError):
        run(replace(SMALL, require_audit=True))


class TestBenchmark:
    def test_hold_out_time_window_moves_latest_items_out_of_training(self) -> None:
        digest = generate_personas(1, seed=4)[0].digest
        training, episode = hold_out_time_window(digest, fraction=0.25, min_hidden=2)
        assert episode is not None and episode.cutoff is not None
        train_ids = {i.id for i in training.items}
        assert not train_ids & {i.id for i in episode.hidden}
        assert all(i.observed_at is None or i.observed_at < episode.cutoff for i in training.items)

    def test_freeze_detects_tampering(self) -> None:
        digest = generate_personas(1, seed=4)[0].digest
        frozen = freeze_benchmark(build_episodes(digest, SplitConfig(), seed=0))
        verify_frozen(frozen)
        tampered = replace(frozen, episodes=frozen.episodes[:-1])
        with pytest.raises(BenchmarkTamperedError):
            verify_frozen(tampered)

    def test_leakage_check_rejects_shared_hidden_items(self) -> None:
        digest = generate_personas(1, seed=4)[0].digest
        episodes = build_episodes(digest, SplitConfig(), seed=0)
        with pytest.raises(BenchmarkLeakageError):
            assert_no_leakage(freeze_benchmark(episodes[:1]), episodes)


def test_single_person_split_uses_only_a_held_out_time_window() -> None:
    training_digests, training_episodes, benchmark, held_out = split_digests(DIGESTS[:1], PipelineConfig(seed=0))
    assert held_out == frozenset()
    assert [d.digest_id for d in training_digests] == [DIGESTS[0].digest_id]
    assert len(benchmark.episodes) == 1
    assert_no_leakage(benchmark, training_episodes)


def test_verifier_calls_are_cached_across_stages() -> None:
    cached = CachingVerifier(KeywordVerifier(keyword_rules()))
    run(verifier=cached)
    assert cached.stats.hits > 0


def test_pipeline_module_does_not_import_synthetic_data() -> None:
    import nailed_it_training.pipeline as pipeline

    assert "synthetic" not in Path(pipeline.__file__).read_text()


def test_stage_a_starvation_is_a_named_error() -> None:
    config = PipelineConfig(seed=0, rl_steps=1, sft_steps=1, group_size=2, groups_per_step=1, teacher_decks_per_episode=1)
    with pytest.raises(StageAStarvedError):
        run(config, digests=DIGESTS[:1])


def test_cli_demo_prints_table(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["demo", "--seed", "0", "--people", "6", "--rl-steps", "3", "--sft-steps", "3"])
    out = capsys.readouterr().out
    assert code == 0
    assert "Full (A + B)" in out
    assert "wiring" in out.lower()
