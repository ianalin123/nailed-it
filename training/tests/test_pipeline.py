import math
from dataclasses import replace

import pytest

from nailed_it_training.cli import main
from nailed_it_training.episodes import SplitConfig, build_episodes
from nailed_it_training.eval import ABLATION_ROWS, AblationRow
from nailed_it_training.fake_backend import FakeBackend
from nailed_it_training.pipeline import (
    BenchmarkLeakageError,
    BenchmarkTamperedError,
    PipelineConfig,
    VerifierDistrustedError,
    assert_no_leakage,
    freeze_benchmark,
    hold_out_time_window,
    run_pipeline,
    verify_frozen,
)
from nailed_it_training.reward import Gate
from nailed_it_training.synthetic import generate_personas, keyword_rules, synthetic_verdicts
from nailed_it_training.verifier import KeywordVerifier

SMALL = PipelineConfig(seed=0, n_train_personas=8, n_eval_personas=2, rl_steps=6, sft_steps=5, group_size=4, groups_per_step=4)


def run(config: PipelineConfig = SMALL, verdicts=None):
    return run_pipeline(FakeBackend(seed=config.seed), KeywordVerifier(keyword_rules()), config, verdicts=verdicts)


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
    personas = generate_personas(SMALL.n_train_personas, seed=SMALL.seed)
    bad = synthetic_verdicts(personas, reads_per_person=6, seed=1, flip_rate=0.9, partly_rate=0.0)
    with pytest.raises(VerifierDistrustedError):
        run(verdicts=bad)


def test_audit_ok_trains_with_critic() -> None:
    personas = generate_personas(SMALL.n_train_personas, seed=SMALL.seed)
    good = synthetic_verdicts(personas, reads_per_person=6, seed=1, flip_rate=0.0, partly_rate=0.05)
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


def test_cli_demo_prints_table(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["demo", "--seed", "0", "--train-personas", "6", "--eval-personas", "2", "--rl-steps", "3", "--sft-steps", "3"])
    out = capsys.readouterr().out
    assert code == 0
    assert "Full (A + B)" in out
    assert "wiring" in out.lower()
