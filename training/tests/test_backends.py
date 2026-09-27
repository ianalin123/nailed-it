import builtins
from pathlib import Path

import pytest

from nailed_it_training.fake_backend import FAKE_BASE, FAKE_TEACHER, FakeBackend, Strategy
from nailed_it_training.reader import parse_reads
from nailed_it_training.river_adapter import (
    CheckpointRef,
    MissingApiKeyError,
    ModelRef,
    RiverBackend,
    RiverClientNotInstalled,
    RlConfig,
    RlRow,
    SftConfig,
    SftExample,
    TrainerBackend,
    UnconfirmedRiverFeature,
)
from nailed_it_training.synthetic import generate_personas

PROMPT_USER = generate_personas(1, seed=0)[0]


def user_prompt() -> str:
    from nailed_it_training.episodes import SplitConfig, build_episodes
    from nailed_it_training.reader import render_reader_prompt

    ep = build_episodes(PROMPT_USER.digest, SplitConfig(), seed=0)[0]
    return render_reader_prompt(ep)[1]


def strategy_share(backend: FakeBackend, target: ModelRef, strategy: Strategy, n: int = 40) -> float:
    texts = backend.sample(target, system="s", user=user_prompt(), n=n, max_tokens=512, temperature=1.0, seed=0)
    reads = [r for t in texts for r in parse_reads(t, model_version="x")]
    return sum(r.id.startswith(strategy.value) for r in reads) / len(reads)


def test_fake_backend_satisfies_protocol() -> None:
    backend: TrainerBackend = FakeBackend(seed=0)
    assert backend is not None


def test_fake_samples_are_deterministic_for_a_seed() -> None:
    backend = FakeBackend(seed=0)
    a = backend.sample(ModelRef(FAKE_BASE), system="s", user=user_prompt(), n=3, max_tokens=512, temperature=1.0, seed=4)
    b = backend.sample(ModelRef(FAKE_BASE), system="s", user=user_prompt(), n=3, max_tokens=512, temperature=1.0, seed=4)
    assert a == b


def test_sft_moves_policy_toward_dataset_strategies() -> None:
    backend = FakeBackend(seed=0)
    teacher_texts = backend.sample(ModelRef(FAKE_TEACHER), system="s", user=user_prompt(), n=20, max_tokens=512, temperature=1.0, seed=0)
    bold_only = [t for t in teacher_texts if Strategy.BOLD.value in t] or teacher_texts
    dataset = backend.upload_dataset("bold", [SftExample(system="s", user=user_prompt(), completion=t) for t in bold_only])
    ckpt = backend.start_sft(dataset, SftConfig(name="sft", base_model=FAKE_BASE, steps=10))
    assert strategy_share(backend, ModelRef(FAKE_BASE, ckpt), Strategy.BOLD) > strategy_share(backend, ModelRef(FAKE_BASE), Strategy.BOLD)


def test_rl_calls_reward_client_side_and_follows_it() -> None:
    backend = FakeBackend(seed=0)
    calls: list[str] = []

    def reward(row: RlRow, completion: str) -> float:
        calls.append(row.row_id)
        reads = parse_reads(completion, model_version="x")
        return sum(r.id.startswith(Strategy.GENERIC.value) for r in reads) / len(reads)

    rows = [RlRow(row_id=f"row{i}", system="s", user=user_prompt()) for i in range(4)]
    config = RlConfig(name="rl", base_model=FAKE_BASE, steps=15, group_size=4, groups_per_step=2, lr=1.0)
    ckpt = backend.run_rl(rows, reward, config)
    assert len(calls) == 15 * 4 * 2
    assert strategy_share(backend, ModelRef(FAKE_BASE, ckpt), Strategy.GENERIC) > strategy_share(
        backend, ModelRef(FAKE_BASE), Strategy.GENERIC
    )


def test_fake_deploy_and_sample_endpoint() -> None:
    backend = FakeBackend(seed=0)
    ckpt = backend.start_sft(backend.upload_dataset("d", [SftExample("s", "u", "{}")]), SftConfig(name="n", base_model=FAKE_BASE, steps=1))
    endpoint = backend.deploy(ckpt)
    assert endpoint.base_url.startswith("fake://")
    assert len(backend.sample(endpoint, system="s", user=user_prompt(), n=2, max_tokens=64, temperature=1.0, seed=0)) == 2


def test_fake_download_adapter_writes_marker(tmp_path: Path) -> None:
    backend = FakeBackend(seed=0)
    ckpt = backend.start_sft(backend.upload_dataset("d", [SftExample("s", "u", "{}")]), SftConfig(name="n", base_model=FAKE_BASE, steps=1))
    out = backend.download_adapter(ckpt, tmp_path)
    assert out.exists()


def test_upload_rejects_empty_dataset() -> None:
    with pytest.raises(ValueError):
        FakeBackend(seed=0).upload_dataset("empty", [])


class TestRiverBackend:
    def test_missing_api_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("RIVER_API_KEY", raising=False)
        with pytest.raises(MissingApiKeyError):
            RiverBackend.from_env()

    def test_blank_api_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RIVER_API_KEY", "  ")
        with pytest.raises(MissingApiKeyError):
            RiverBackend.from_env()

    def test_missing_client_package_raises_clear_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RIVER_API_KEY", "rv_test_not_real")
        real_import = builtins.__import__

        def fake_import(name: str, *args, **kwargs):
            if name == "river_client" or name.startswith("river_client."):
                raise ModuleNotFoundError("No module named 'river_client'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        with pytest.raises(RiverClientNotInstalled, match="uv sync --extra river"):
            RiverBackend.from_env()

    def test_download_adapter_is_unconfirmed(self, tmp_path: Path) -> None:
        backend = RiverBackend.__new__(RiverBackend)
        with pytest.raises(UnconfirmedRiverFeature, match="Console"):
            backend.download_adapter(CheckpointRef(training_path="river://x/weights/a", inference_path=None, base_model="b"), tmp_path)

    def test_deploy_requires_inference_checkpoint(self) -> None:
        backend = RiverBackend.__new__(RiverBackend)
        with pytest.raises(ValueError, match="inference"):
            backend.deploy(CheckpointRef(training_path="river://x/weights/a", inference_path=None, base_model="b"))
