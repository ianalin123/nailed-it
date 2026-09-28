import json
from pathlib import Path

import pytest

from nailed_it_training.base_rate import CategoryShrunkBaseRate
from nailed_it_training.episodes import SplitConfig, build_episodes
from nailed_it_training.fake_backend import FAKE_BASE, FakeBackend
from nailed_it_training.ledger import SpendLedger, Usage
from nailed_it_training.pipeline import (
    DeckScorer,
    PipelineConfig,
    StopPolicy,
    Telemetry,
    information_gain_reward,
    metrics_hook,
    run_stage_a,
)
from nailed_it_training.protocol import EvidenceItem
from nailed_it_training.reader import parse_reads, render_reader_prompt
from nailed_it_training.reward import RewardConfig
from nailed_it_training.river_adapter import RlConfig, RlRow, StepInfo, StopTraining
from nailed_it_training.synthetic import LexiconJudge, generate_personas, keyword_rules
from nailed_it_training.verifier import KeywordVerifier, VerifierVerdict

DIGEST = generate_personas(1, seed=0)[0].digest
EPISODES = build_episodes(DIGEST, SplitConfig(), seed=0)


def scorer(verifier=None, cap: int = 80) -> DeckScorer:
    return DeckScorer(verifier or KeywordVerifier(keyword_rules()), CategoryShrunkBaseRate(LexiconJudge()), RewardConfig(), evidence_cap=cap)


class TestStageA:
    def test_verified_examples_are_exact_twelve_read_decks(self) -> None:
        config = PipelineConfig(teacher_decks_per_episode=8)
        result = run_stage_a(FakeBackend(seed=0), scorer(), EPISODES, config)
        assert result.verified_examples, "fixture should yield at least one full deck"
        for ex in result.verified_examples:
            reads = parse_reads(ex.completion, model_version="x")
            assert len(reads) == 12
            assert [r.id for r in reads] == [f"r{i}" for i in range(1, 13)]
            assert len({r.text for r in reads}) == 12
        assert result.n_skipped_episodes + len({ex.user for ex in result.verified_examples}) >= 1
        assert result.n_skipped_episodes >= 0

    def test_episodes_with_too_few_survivors_are_skipped_and_counted(self) -> None:
        config = PipelineConfig(teacher_decks_per_episode=1)
        result = run_stage_a(FakeBackend(seed=0), scorer(), EPISODES, config)
        assert result.n_skipped_episodes == len(EPISODES) - len({ex.user for ex in result.verified_examples})


class SpyVerifier:
    def __init__(self) -> None:
        self.inner = KeywordVerifier(keyword_rules())
        self.sets: list[list[EvidenceItem]] = []

    def verify(self, read_text: str, hidden: list[EvidenceItem]) -> VerifierVerdict:
        return self.verify_many([read_text], hidden)[0]

    def verify_many(self, read_texts: list[str], hidden: list[EvidenceItem]) -> list[VerifierVerdict]:
        self.sets.append(list(hidden))
        return self.inner.verify_many(read_texts, hidden)


def test_scorer_caps_each_evidence_set_and_keeps_sides_apart() -> None:
    spy = SpyVerifier()
    episode = max(EPISODES, key=lambda e: len(e.hidden))
    text = FakeBackend(seed=0).sample(
        __import__("nailed_it_training.river_adapter", fromlist=["ModelRef"]).ModelRef(FAKE_BASE),
        system="s",
        user=render_reader_prompt(episode)[1],
        n=1,
        max_tokens=100,
        temperature=1.0,
        seed=0,
    )[0]
    scorer(spy, cap=5).score(episode, parse_reads(text, model_version="x"))
    hidden_call, visible_call = spy.sets
    assert len(hidden_call) <= 5 and len(visible_call) <= 5
    assert {i.id for i in hidden_call} <= {i.id for i in episode.hidden}
    assert {i.id for i in visible_call} <= episode.visible_ids


class TestTelemetry:
    def test_summarises_scored_decks_and_malformed_outputs(self) -> None:
        telemetry = Telemetry()
        episode = EPISODES[0]
        reward = information_gain_reward(scorer(), {episode.episode_id: episode}, PipelineConfig(), telemetry=telemetry)
        text = FakeBackend(seed=0).sample(
            __import__("nailed_it_training.river_adapter", fromlist=["ModelRef"]).ModelRef(FAKE_BASE),
            system="s",
            user=render_reader_prompt(episode)[1],
            n=2,
            max_tokens=100,
            temperature=1.0,
            seed=0,
        )
        row = RlRow(episode.episode_id, "s", "u")
        for t in text:
            reward(row, t)
        reward(row, "not json")
        summary = telemetry.drain()
        assert summary["n_decks"] == 3 and summary["n_malformed"] == 1
        for key in ("mean_reward", "mean_information_gain", "share_restatement", "share_ungrounded", "share_unverifiable", "mean_confidence"):
            assert key in summary
        assert telemetry.drain()["n_decks"] == 0


def info(n: int, reward: float, unverifiable: float = 0.2) -> tuple[StepInfo, dict]:
    return StepInfo(run="r", n=n, model_step=n, river_metrics={}, usage={}, cost_usd=0.0), {
        "mean_reward": reward,
        "share_unverifiable": unverifiable,
    }


class TestStopPolicy:
    def test_flat_or_falling_over_fifteen_steps_stops(self) -> None:
        policy = StopPolicy(window=15)
        history = [{"mean_reward": 1.0 - 0.01 * i, "share_unverifiable": 0.1} for i in range(15)]
        assert policy.reason(history, spent=0.0) is not None

    def test_rising_reward_does_not_stop(self) -> None:
        policy = StopPolicy(window=15)
        history = [{"mean_reward": 0.01 * i, "share_unverifiable": 0.1} for i in range(30)]
        assert policy.reason(history, spent=0.0) is None

    def test_fewer_than_window_steps_never_stops_on_trend(self) -> None:
        history = [{"mean_reward": -float(i), "share_unverifiable": 0.1} for i in range(14)]
        assert StopPolicy(window=15).reason(history, spent=0.0) is None

    def test_unverifiable_share_over_seventy_percent_stops(self) -> None:
        history = [{"mean_reward": float(i), "share_unverifiable": 0.9} for i in range(3)]
        assert "unverifiable" in (StopPolicy().reason(history, spent=0.0) or "")

    def test_spend_limit_stops(self) -> None:
        assert "spend" in (StopPolicy(spend_limit=45.0).reason([{"mean_reward": 1.0, "share_unverifiable": 0.1}], spent=45.0) or "")


def test_metrics_hook_writes_each_step_and_stops_training(tmp_path: Path) -> None:
    path = tmp_path / "metrics.jsonl"
    telemetry = Telemetry()
    ledger = SpendLedger(cap_usd=50.0, pricing={FAKE_BASE: __import__("nailed_it_training.ledger", fromlist=["Price"]).Price(1, 1, 1, 1)})
    hook = metrics_hook("run-x", telemetry, path, StopPolicy(spend_limit=0.5), ledger)
    hook(StepInfo(run="run-x", n=1, model_step=1, river_metrics={"train/updated": 1.0}, usage={"prompt_tokens": 10}, cost_usd=0.1))
    ledger.record(Usage(FAKE_BASE, "x", prompt_tokens=1_000_000))
    with pytest.raises(StopTraining):
        hook(StepInfo(run="run-x", n=2, model_step=2, river_metrics={}, usage={}, cost_usd=0.0))
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [r["n"] for r in rows] == [1, 2]
    assert rows[0]["river"]["train/updated"] == 1.0
    assert rows[1]["stop_reason"] is not None
    assert "spent_usd" in rows[0]


class TestFakeBackendHooks:
    def rows(self) -> list[RlRow]:
        return [RlRow(e.episode_id, "s", render_reader_prompt(e)[1]) for e in EPISODES[:2]]

    def test_on_step_called_every_step_and_periodic_checkpoints_saved(self) -> None:
        backend = FakeBackend(seed=0)
        seen: list[int] = []
        config = RlConfig(name="rl", base_model=FAKE_BASE, steps=25, group_size=2, groups_per_step=1, checkpoint_every=10)
        backend.run_rl(self.rows(), lambda r, c: 0.0, config, on_step=lambda s: seen.append(s.n))
        assert seen == list(range(1, 26))
        assert [c.training_path for c in backend.periodic_checkpoints] == ["fake://rl-step010", "fake://rl-step020"]

    def test_stop_training_saves_and_returns(self) -> None:
        backend = FakeBackend(seed=0)

        def hook(step: StepInfo) -> None:
            if step.n == 3:
                raise StopTraining("test stop")

        config = RlConfig(name="rl", base_model=FAKE_BASE, steps=10, group_size=2, groups_per_step=1)
        ckpt = backend.run_rl(self.rows(), lambda r, c: 0.0, config, on_step=hook)
        assert backend.stop_reason == "test stop"
        assert ckpt.training_path == "fake://rl"


def test_one_overlong_read_costs_that_read_not_the_whole_deck(tmp_path: Path) -> None:
    from nailed_it_training.river_adapter import ModelRef

    episode = EPISODES[0]
    text = FakeBackend(seed=0).sample(
        ModelRef(FAKE_BASE), system="s", user=render_reader_prompt(episode)[1], n=1, max_tokens=100, temperature=1.0, seed=0
    )[0]
    payload = json.loads(text)
    payload["reads"][0]["text"] = "x" * 300
    telemetry = Telemetry(capture=tmp_path / "failures.jsonl")
    config = PipelineConfig()
    reward = information_gain_reward(scorer(), {episode.episode_id: episode}, config, telemetry=telemetry)
    value = reward(RlRow(episode.episode_id, "s", "u"), json.dumps(payload))
    assert value > config.malformed_reward
    summary = telemetry.drain()
    assert summary["n_malformed"] == 0 and summary["share_invalid"] == pytest.approx(1 / 12)
    captured = [json.loads(line) for line in (tmp_path / "failures.jsonl").read_text().splitlines()]
    assert captured[0]["kind"] == "invalid_reads" and "reads[0]" in captured[0]["errors"][0]
