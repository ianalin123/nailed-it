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


def step(ig: float, unverifiable: float) -> dict:
    return {"mean_reward": ig, "mean_information_gain": ig, "share_unverifiable": unverifiable}


class TestStopPolicy:
    def test_no_absolute_unverifiable_threshold(self) -> None:
        history = [step(0.2, 0.9)] * 30
        assert StopPolicy().reason(history, spent=0.0) is None

    def test_unverifiable_fifteen_points_above_first_step_for_five_steps_stops(self) -> None:
        history = [step(0.2, 0.55)] + [step(0.3, 0.71)] * 5
        assert "unverifiable" in (StopPolicy().reason(history, spent=0.0) or "")

    def test_four_high_steps_or_a_broken_run_do_not_stop(self) -> None:
        assert StopPolicy().reason([step(0.2, 0.55)] + [step(0.3, 0.75)] * 4, spent=0.0) is None
        broken = [step(0.2, 0.55), *([step(0.3, 0.75)] * 4), step(0.3, 0.6), step(0.3, 0.75)]
        assert StopPolicy().reason(broken, spent=0.0) is None

    def test_information_gain_below_first_step_for_ten_steps_stops(self) -> None:
        history = [step(0.2, 0.5)] + [step(0.1, 0.5)] * 10
        assert "information gain" in (StopPolicy().reason(history, spent=0.0) or "")

    def test_nine_low_steps_do_not_stop(self) -> None:
        assert StopPolicy().reason([step(0.2, 0.5)] + [step(0.1, 0.5)] * 9, spent=0.0) is None

    def test_missing_values_break_a_run(self) -> None:
        history = [step(0.2, 0.5)] + [step(0.1, 0.5)] * 5 + [{"mean_information_gain": None, "share_unverifiable": None}] + [step(0.1, 0.5)] * 5
        assert StopPolicy().reason(history, spent=0.0) is None

    def test_spend_limit_stops(self) -> None:
        assert "spend" in (StopPolicy(spend_limit=45.0).reason([step(0.2, 0.5)], spent=45.0) or "")


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


def test_paraphrase_of_visible_item_earns_far_less_than_a_combining_inference() -> None:
    from nailed_it_training.base_rate import CategoryShrunkBaseRate
    from nailed_it_training.episodes import Episode, EpisodeKind
    from nailed_it_training.protocol import ChainKind, ChainStep, Read, ReadCategory, SourceKind
    from nailed_it_training.verifier import TraitRule

    visible = (
        EvidenceItem(id="v1", source=SourceKind.GIT_HISTORY, text="Committed the parser fix at 2am again."),
        EvidenceItem(id="v2", source=SourceKind.CALENDAR, text="Declined the Monday standup, asked for a written update."),
    )
    hidden = (
        EvidenceItem(id="h1", source=SourceKind.GIT_HISTORY, text="Committed the lexer fix at 3am."),
        EvidenceItem(id="h2", source=SourceKind.CALENDAR, text="Blocked mornings as no-meeting deep work time."),
    )
    episode = Episode("e", "d", "P", EpisodeKind.TEMPORAL, visible, hidden)
    paraphrase = "You commit parser fixes at 2am."
    inference = "You guard long solo stretches for deep work."
    rules = [
        TraitRule(paraphrase.lower(), ("committed the lexer fix", "committed the parser fix at 2am"), ()),
        TraitRule(inference.lower(), ("deep work time",), ()),
    ]

    class Judge:
        def judge_many(self, reads: list[tuple[str, ReadCategory]]) -> list[float]:
            return [0.2 for _ in reads]

    def make(read_id: str, text: str) -> Read:
        chain = [ChainStep(kind=ChainKind.EVIDENCE, text="[v1] x"), ChainStep(kind=ChainKind.EVIDENCE, text="[v2] y")]
        return Read(
            id=read_id, text=text, category=ReadCategory.WORK_STYLE, confidence=0.7,
            evidence_ids=["v1", "v2"], hops=2, model_version="m", chain=chain,
        )

    deck_scorer = DeckScorer(KeywordVerifier(rules), CategoryShrunkBaseRate(Judge()), RewardConfig())
    deck = deck_scorer.score(episode, [make("a", paraphrase), make("b", inference)])
    para, infer = deck.reads
    assert para.outcome == 1 and infer.outcome == 1
    assert infer.reward > 0.5
    assert para.reward < 0.1 * infer.reward
    assert para.distance_weight < 0.1 and infer.distance_weight == 1.0
