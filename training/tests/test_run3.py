import json
import random
from dataclasses import dataclass
from pathlib import Path

import pytest

from nailed_it_training.base_rate import CategoryShrunkBaseRate
from nailed_it_training.episodes import SplitConfig, build_episodes
from nailed_it_training.fake_backend import FAKE_BASE, FakeBackend
from nailed_it_training.per_read import bytes_to_unicode
from nailed_it_training.pipeline import DeckScorer
from nailed_it_training.reader import render_reader_prompt
from nailed_it_training.reward import RewardConfig
from nailed_it_training.river_adapter import CheckpointRef, ModelRef
from nailed_it_training.run3 import MatchedStop, Run3Config, Trainer, epoch_schedule
from nailed_it_training.synthetic import LexiconJudge, generate_personas, keyword_rules
from nailed_it_training.verifier import KeywordVerifier

DIGEST = generate_personas(1, seed=0)[0].digest
EPISODES = build_episodes(DIGEST, SplitConfig(), seed=0)[:5]


class ByteTokenizer:
    """One token per byte, byte-level BPE alphabet, so the aligner sees realistic pieces."""

    enc = bytes_to_unicode()

    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]:
        return list(text.encode("utf-8"))

    def convert_ids_to_tokens(self, i: int) -> str:
        return self.enc[i]


@dataclass
class FakeSample:
    tokens: list[int]
    logprobs: list[float]
    stop_reason: str = "stop"
    token_data_is_exact: bool = True


class FakePolicy:
    def __init__(self, mangle_every: int = 0) -> None:
        self.backend = FakeBackend(seed=0)
        self.tok = ByteTokenizer()
        self.trained: list[list[dict]] = []
        self.saved: list[str] = []
        self.mangle_every = mangle_every
        self.calls = 0

    def sample(self, prompt_ids: list[int], *, n: int, seed: int) -> list[FakeSample]:
        user = bytes(prompt_ids).decode("utf-8")
        texts = self.backend.sample(ModelRef(FAKE_BASE), system="s", user=user, n=n, max_tokens=4096, temperature=1.0, seed=seed)
        out = []
        for t in texts:
            self.calls += 1
            mangled = bool(self.mangle_every) and self.calls % self.mangle_every == 0
            text = t[: len(t) // 2] if mangled else t
            ids = self.tok.encode(text)
            out.append(FakeSample(tokens=ids, logprobs=[-0.5] * len(ids), stop_reason="length" if mangled else "stop"))
        return out

    def train(self, batch: list[dict]) -> None:
        self.trained.append(batch)

    def save(self, name: str) -> CheckpointRef:
        self.saved.append(name)
        return CheckpointRef(training_path=f"fake://{name}", inference_path=f"fake://{name}-inf", base_model=FAKE_BASE)


def trainer(tmp_path: Path, policy: FakePolicy, steps: int = 4, checkpoints: tuple[int, ...] = (2, 4)) -> Trainer:
    scorer = DeckScorer(KeywordVerifier(keyword_rules()), CategoryShrunkBaseRate(LexiconJudge()), RewardConfig())
    prompts = {e.episode_id: policy.tok.encode(render_reader_prompt(e)[1]) for e in EPISODES}
    config = Run3Config(steps=steps, checkpoints=checkpoints, group_size=4, groups_per_step=2, workers=2, seed=0)
    return Trainer(policy, policy.tok, scorer, {e.episode_id: e for e in EPISODES}, prompts, config, metrics_path=tmp_path / "m.jsonl")


def test_epoch_schedule_is_seeded_and_covers_every_episode_each_epoch() -> None:
    ids = [f"e{i}" for i in range(12)]
    a = epoch_schedule(ids, steps=6, per_step=4, seed=3)
    assert a == epoch_schedule(ids, steps=6, per_step=4, seed=3)
    assert a != epoch_schedule(ids, steps=6, per_step=4, seed=4)
    assert sorted(x for step in a[:3] for x in step) == sorted(ids)
    assert all(len(set(step)) == 4 for step in a)


def test_trains_only_read_tokens_with_matching_lengths(tmp_path: Path) -> None:
    policy = FakePolicy()
    result = trainer(tmp_path, policy).run()
    assert len(policy.trained) == 4
    for batch in policy.trained:
        for datum in batch:
            n = len(datum["input_ids"])
            assert len(datum["old_logprobs"]) == len(datum["advantages"]) == len(datum["attention_mask"]) == n
            prompt_len = n - sum(1 for _ in datum["_completion"])
            assert all(a == 0.0 for a in datum["advantages"][: prompt_len - 1])
            assert datum["advantages"][-1] == 0.0
            completion = bytes(datum["_completion"]).decode("utf-8", errors="strict")
            adv = datum["advantages"][prompt_len - 1 : -1]
            assert adv[0] == 0.0
            assert completion.startswith('{"reads"')
    assert policy.saved == ["nailed-run3-step002", "nailed-run3-step004"]
    assert [c["step"] for c in result.checkpoints] == [2, 4]


def test_truncated_decks_get_one_whole_sequence_advantage(tmp_path: Path) -> None:
    policy = FakePolicy(mangle_every=3)
    trainer(tmp_path, policy, steps=2, checkpoints=()).run()
    rows = [json.loads(line) for line in (tmp_path / "m.jsonl").read_text().splitlines()]
    assert sum(r["n_malformed"] for r in rows) > 0
    assert all(r["n_misaligned"] == 0 for r in rows)
    whole = [d for batch in policy.trained for d in batch if d["_whole_sequence"]]
    assert whole
    for d in whole:
        adv = [a for a in d["advantages"] if a != 0.0]
        assert len(set(adv)) == 1


def test_metrics_written_every_step_with_matched_deltas(tmp_path: Path) -> None:
    trainer(tmp_path, FakePolicy(), steps=4, checkpoints=()).run()
    rows = [json.loads(line) for line in (tmp_path / "m.jsonl").read_text().splitlines()]
    assert [r["n"] for r in rows] == [1, 2, 3, 4]
    for key in ("mean_information_gain", "share_unverifiable", "share_restatement", "episodes", "matched_ig_delta", "n_trained_decks"):
        assert key in rows[0]
    assert rows[0]["matched_ig_delta"] is None


class TestMatchedStop:
    def test_stops_after_five_negative_matched_ig_deltas(self) -> None:
        stop = MatchedStop(run_length=5)
        reasons = [stop.update(ig_delta=-0.1, unverifiable_delta=0.0, spent=0.0) for _ in range(5)]
        assert reasons[:4] == [None] * 4 and reasons[4] is not None

    def test_undefined_delta_does_not_break_or_extend_a_run(self) -> None:
        stop = MatchedStop(run_length=3)
        seq = [stop.update(ig_delta=d, unverifiable_delta=None, spent=0.0) for d in (-0.1, None, -0.1, 0.2, -0.1)]
        assert seq == [None] * 5

    def test_unverifiable_rise_and_spend_guard(self) -> None:
        stop = MatchedStop(run_length=2, spend_guard=10.0)
        assert stop.update(ig_delta=None, unverifiable_delta=0.2, spent=0.0) is None
        assert "unverifiable" in (stop.update(ig_delta=None, unverifiable_delta=0.2, spent=0.0) or "")
        assert "spend" in (MatchedStop(spend_guard=10.0).update(ig_delta=None, unverifiable_delta=None, spent=10.0) or "")


class StubModel:
    def __init__(self) -> None:
        self.fb: list[tuple[int, bool, dict]] = []
        self.optim: list[dict] = []
        self.sample_kwargs: dict = {}

    def sample(self, **kwargs: object) -> list[list[FakeSample]]:
        self.sample_kwargs = kwargs
        return [[FakeSample(tokens=[1, 2, 3], logprobs=[-1.0] * 3) for _ in range(int(kwargs["num_samples"]))]]  # type: ignore[call-overload]

    def forward_backward(self, data: list[dict], loss_fn: str, eps_max: float, zero_out: bool) -> None:
        assert loss_fn == "cispo"
        assert all(not k.startswith("_") for d in data for k in d)
        self.fb.append((len(data), zero_out, data[0]))

    def optim_step(self, **kwargs: object) -> None:
        self.optim.append(kwargs)


def test_river_policy_meters_microbatches_and_strips_private_keys() -> None:
    from nailed_it_training.ledger import SpendCapExceeded, SpendLedger
    from nailed_it_training.run3 import RiverPolicy

    model = StubModel()
    ledger = SpendLedger(cap_usd=5.0)
    policy = RiverPolicy(None, model, "Qwen/Qwen3.6-35B-A3B-FP8", ledger, max_tokens=100, lr=1e-5, stop=["<|im_end|>"])
    samples = policy.sample([1, 2], n=4, seed=0)
    assert len(samples) == 4 and model.sample_kwargs["prompt_token_ids"] == [1, 2] and model.sample_kwargs["temperature"] == 1.0
    datum = {
        "input_ids": [1] * 10, "attention_mask": [1] * 10, "old_logprobs": [0.0] * 10, "advantages": [0.0] * 10,
        "_completion": [], "_whole_sequence": False,
    }
    policy.train([datum] * 19)
    assert [(n, z) for n, z, _ in model.fb] == [(8, True), (8, False), (3, False)]
    assert len(model.optim) == 1 and model.optim[0]["lr"] == 1e-5
    totals = ledger.totals()
    assert totals["prompt_tokens"] == 8 and totals["completion_tokens"] == 12 and totals["training_tokens"] == 190
    broke = RiverPolicy(None, StubModel(), "Qwen/Qwen3.6-35B-A3B-FP8", SpendLedger(cap_usd=1e-9), max_tokens=100, lr=1e-5, stop=[])
    with pytest.raises(SpendCapExceeded):
        broke.sample([1, 2], n=4, seed=0)


def test_verdict_rule_matches_the_fixed_definition() -> None:
    from nailed_it_training.run3_stages import verdict

    base_extras = {"supported_share_ci": [0.2, 0.3]}
    assert verdict({"ig_ci_low": 0.14, "ig_ci_high": 0.3, "restatement_rate": 0.6}, base_extras).startswith("improved")
    assert verdict({"ig_ci_low": 0.0, "ig_ci_high": 0.12, "restatement_rate": 0.4}, base_extras).startswith("worse")
    assert verdict({"ig_ci_low": 0.05, "ig_ci_high": 0.2, "restatement_rate": 0.4}, base_extras) == "not distinguishable"
    better_supported = {"supported_share_ci": [0.33, 0.4]}
    assert verdict({"ig_ci_low": 0.05, "ig_ci_high": 0.2, "restatement_rate": 0.40}, better_supported).startswith("improved")
    assert verdict({"ig_ci_low": 0.05, "ig_ci_high": 0.2, "restatement_rate": 0.50}, better_supported) == "not distinguishable"


def test_blind_picker_is_stratified_seeded_and_complete() -> None:
    from nailed_it_training.run3_stages import _pick

    reads = [{"category": c, "text": f"{c}{i}"} for c in ("a", "b", "c") for i in range(20)]
    first = _pick([dict(r) for r in reads], 30, random.Random(1))
    again = _pick([dict(r) for r in reads], 30, random.Random(1))
    assert [r["text"] for r in first] == [r["text"] for r in again]
    counts = {c: sum(r["category"] == c for r in first) for c in "abc"}
    assert counts == {"a": 10, "b": 10, "c": 10}
    with pytest.raises(ValueError):
        _pick(reads[:5], 30, random.Random(1))
