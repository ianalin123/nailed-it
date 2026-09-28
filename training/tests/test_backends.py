import builtins
from pathlib import Path

import pytest

from nailed_it_training.fake_backend import FAKE_BASE, FAKE_TEACHER, FakeBackend, Strategy
from nailed_it_training.ledger import SpendCapExceeded, SpendLedger
from nailed_it_training.reader import parse_reads
from nailed_it_training.river_adapter import (
    CheckpointRef,
    Endpoint,
    MissingApiKeyError,
    ModelRef,
    RiverBackend,
    RiverClientNotInstalled,
    RlConfig,
    RlRow,
    SftConfig,
    SftExample,
    TrainerBackend,
    TruncatedResponseError,
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
            RiverBackend.from_env(SpendLedger(cap_usd=1.0))

    def test_blank_api_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RIVER_API_KEY", "  ")
        with pytest.raises(MissingApiKeyError):
            RiverBackend.from_env(SpendLedger(cap_usd=1.0))

    def test_missing_client_package_raises_clear_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RIVER_API_KEY", "rv_test_not_real")
        real_import = builtins.__import__

        def fake_import(name: str, *args, **kwargs):
            if name == "river_client" or name.startswith("river_client."):
                raise ModuleNotFoundError("No module named 'river_client'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        with pytest.raises(RiverClientNotInstalled, match="uv sync --extra river"):
            RiverBackend.from_env(SpendLedger(cap_usd=1.0))

    def test_download_adapter_is_unconfirmed(self, tmp_path: Path) -> None:
        backend = RiverBackend.__new__(RiverBackend)
        with pytest.raises(UnconfirmedRiverFeature, match="Console"):
            backend.download_adapter(CheckpointRef(training_path="river://x/weights/a", inference_path=None, base_model="b"), tmp_path)

    def test_deploy_requires_inference_checkpoint(self) -> None:
        backend = RiverBackend.__new__(RiverBackend)
        with pytest.raises(ValueError, match="inference"):
            backend.deploy(CheckpointRef(training_path="river://x/weights/a", inference_path=None, base_model="b"))


class StubSample:
    def __init__(self, text: str, stop_reason: str = "stop") -> None:
        self.text = text
        self.tokens = [1] * 50
        self.prompt_tokens = 200
        self.cached_prompt_tokens = 0
        self.stop_reason = stop_reason


class StubTokenizer:
    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]:
        return [0] * len(text.split())


class StubRenderer:
    tokenizer = StubTokenizer()

    class _Prompt:
        def __init__(self, prompt: str) -> None:
            self.prompt = prompt

    def build_sample_prompt(self, messages: list[dict[str, str]]) -> "StubRenderer._Prompt":
        return self._Prompt("\n".join(m["content"] for m in messages))

    def get_stop_strings(self) -> list[str]:
        return ["<|im_end|>"]


class StubClient:
    def __init__(self, reply: StubSample) -> None:
        self.reply = reply
        self.calls = 0

    def sample(self, prompt: str, **kwargs: object) -> list[StubSample]:
        self.calls += 1
        return [self.reply] * int(kwargs["num_samples"])  # type: ignore[call-overload]


BASE = "Qwen/Qwen3.6-35B-A3B-FP8"


def stub_backend(ledger: SpendLedger, reply: StubSample) -> tuple[RiverBackend, StubClient]:
    backend = RiverBackend.__new__(RiverBackend)
    client = StubClient(reply)
    backend._client = client
    backend._ledger = ledger
    backend._renderers = {BASE: StubRenderer()}
    return backend, client


class TestRiverLedger:
    def test_llm_client_records_river_reported_tokens(self) -> None:
        ledger = SpendLedger(cap_usd=5.0)
        backend, client = stub_backend(ledger, StubSample('{"verdicts": []}'))
        text = backend.llm_client(BASE, max_tokens=512, label="verifier").complete("sys", "user")
        assert text == '{"verdicts": []}'
        assert client.calls == 1
        assert ledger.totals()["prompt_tokens"] == 200 and ledger.totals()["completion_tokens"] == 50
        assert ledger.spent == pytest.approx((200 * 0.33 + 50 * 0.82) / 1e6)

    def test_zero_prompt_tokens_from_river_fall_back_to_local_count(self) -> None:
        ledger = SpendLedger(cap_usd=5.0)
        reply = StubSample("{}")
        reply.prompt_tokens = 0
        backend, _ = stub_backend(ledger, reply)
        backend.llm_client(BASE, max_tokens=64, label="judge").complete("one two", "three four five")
        assert ledger.totals()["prompt_tokens"] == 5

    def test_cap_refuses_before_river_is_called(self) -> None:
        ledger = SpendLedger(cap_usd=1e-6)
        backend, client = stub_backend(ledger, StubSample("x"))
        with pytest.raises(SpendCapExceeded):
            backend.llm_client(BASE, max_tokens=4096, label="verifier").complete("sys", "user")
        assert client.calls == 0

    def test_truncated_response_raises(self) -> None:
        backend, _ = stub_backend(SpendLedger(cap_usd=5.0), StubSample("{", stop_reason="length"))
        with pytest.raises(TruncatedResponseError):
            backend.llm_client(BASE, max_tokens=16, label="judge").complete("s", "u")

    def test_endpoint_sampling_is_refused_because_it_cannot_be_metered(self) -> None:
        backend, _ = stub_backend(SpendLedger(cap_usd=5.0), StubSample("x"))
        with pytest.raises(UnconfirmedRiverFeature):
            backend.sample(Endpoint("https://x", "m"), system="s", user="u", n=1, max_tokens=8, temperature=0.0, seed=0)


class TimeoutClient:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] = {}

    def sample(self, prompt: str, **kwargs: object) -> list[StubSample]:
        from river_client.types import RiverTimeoutError

        self.kwargs = kwargs
        raise RiverTimeoutError("request timed out")


def test_river_timeouts_become_llm_call_errors_and_carry_a_timeout() -> None:
    from nailed_it_training.verifier import LlmCallError

    ledger = SpendLedger(cap_usd=5.0)
    backend, _ = stub_backend(ledger, StubSample("x"))
    client = TimeoutClient()
    backend._client = client
    with pytest.raises(LlmCallError):
        backend.llm_client(BASE, max_tokens=64, label="verifier").complete("s", "u")
    assert client.kwargs["timeout"] == 180.0
    assert ledger.spent == 0.0


class ChunkedRenderer(StubRenderer):
    class _Example:
        def to_dict(self) -> dict[str, object]:
            return {"model_input": [{"type": "text", "tokens": [1, 2, 3]}], "weights": [0.0, 1.0, 1.0]}

    def build_training_example(self, messages: list[dict[str, str]]) -> "ChunkedRenderer._Example":
        return self._Example()


class RecordingSession:
    def __init__(self) -> None:
        self.batches: list[list[dict[str, object]]] = []

    def __enter__(self) -> "RecordingSession":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def create_model(self, **kwargs: object) -> "RecordingSession":
        return self

    def forward_backward(self, batch: list[dict[str, object]], loss_fn: str) -> None:
        self.batches.append(batch)

    def optim_step(self, lr: float, grad_clip_norm: float) -> None:
        return None

    def save_weights(self, name: str, mode: str) -> object:
        return type("Ckpt", (), {"path": f"river://x/{mode}/{name}"})()


def test_sft_accepts_chunked_training_examples_and_meters_tokens() -> None:
    from nailed_it_training.river_adapter import SftConfig, SftExample

    ledger = SpendLedger(cap_usd=5.0)
    backend, _ = stub_backend(ledger, StubSample("x"))
    backend._renderers = {BASE: ChunkedRenderer()}
    session = RecordingSession()
    backend._client = type("C", (), {"session": lambda self, **kw: session})()
    backend._river = type("R", (), {"LoraConfig": lambda self=None, **kw: kw})()
    backend._datasets = {}
    handle = backend.upload_dataset("d", [SftExample("s", "u", "c")] * 3)
    ckpt = backend.start_sft(handle, SftConfig(name="n", base_model=BASE, steps=2, batch_size=2))
    assert len(session.batches) == 2
    assert ledger.totals()["training_tokens"] == 2 * 2 * 3
    assert ckpt.inference_path == "river://x/inference/n-inference"
