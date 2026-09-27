"""Trainer backend protocol and the River implementation.

River calls follow docs.river.ai and the installed river-client 0.12.0 (docs/working/river-notes.md).
Anything neither shows is marked UNCONFIRMED and raises UnconfirmedRiverFeature instead of guessing.
Every River call is checked against a SpendLedger before it is made and recorded after.
"""

import asyncio
import json
import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from nailed_it_training.ledger import SpendCapExceeded, SpendLedger, Usage, estimate_tokens

RIVER_API_KEY_ENV = "RIVER_API_KEY"


class MissingApiKeyError(RuntimeError):
    pass


class RiverClientNotInstalled(RuntimeError):
    pass


class UnconfirmedRiverFeature(NotImplementedError):
    pass


class TruncatedResponseError(RuntimeError):
    pass


@dataclass(frozen=True)
class SftExample:
    system: str
    user: str
    completion: str


@dataclass(frozen=True)
class RlRow:
    row_id: str
    system: str
    user: str


@dataclass(frozen=True)
class DatasetHandle:
    name: str
    n_examples: int


@dataclass(frozen=True)
class CheckpointRef:
    training_path: str
    inference_path: str | None
    base_model: str


@dataclass(frozen=True)
class ModelRef:
    base_model: str
    checkpoint: CheckpointRef | None = None


@dataclass(frozen=True)
class Endpoint:
    base_url: str
    model: str


@dataclass(frozen=True)
class SftConfig:
    name: str
    base_model: str
    steps: int = 30
    batch_size: int = 16
    lr: float = 2e-4
    lora_rank: int = 16
    init_checkpoint: CheckpointRef | None = None


@dataclass(frozen=True)
class RlConfig:
    name: str
    base_model: str
    steps: int = 20
    group_size: int = 8
    groups_per_step: int = 8
    lr: float = 1e-5
    lora_rank: int = 16
    max_generated_tokens: int = 4096
    max_context_tokens: int = 16384
    temperature: float = 1.0
    seed: int = 0
    init_checkpoint: CheckpointRef | None = None


RewardFn = Callable[[RlRow, str], float]
SampleTarget = ModelRef | Endpoint


class TrainerBackend(Protocol):
    def upload_dataset(self, name: str, examples: Sequence[SftExample]) -> DatasetHandle: ...

    def start_sft(self, dataset: DatasetHandle, config: SftConfig) -> CheckpointRef: ...

    def run_rl(self, rows: Sequence[RlRow], reward_fn: RewardFn, config: RlConfig) -> CheckpointRef: ...

    def deploy(self, checkpoint: CheckpointRef) -> Endpoint: ...

    def sample(
        self, target: SampleTarget, *, system: str, user: str, n: int, max_tokens: int, temperature: float, seed: int
    ) -> list[str]: ...

    def download_adapter(self, checkpoint: CheckpointRef, dest: Path) -> Path: ...


def require_nonempty(name: str, examples: Sequence[object]) -> None:
    if not examples:
        raise ValueError(f"dataset {name!r} is empty")


def read_api_key() -> str:
    key = os.environ.get(RIVER_API_KEY_ENV, "").strip()
    if not key:
        raise MissingApiKeyError(f"set {RIVER_API_KEY_ENV} in the environment (see .env.example); it is never read from a file")
    return key


def _import_river() -> Any:
    try:
        import river_client
    except ModuleNotFoundError as err:
        raise RiverClientNotInstalled("river-client is not installed. Run `uv sync --extra river`.") from err
    return river_client


class RiverBackend:
    """River Cloud backend. Holds the key in memory only. thinking=False disables Qwen reasoning blocks to save tokens."""

    def __init__(
        self, api_key: str, ledger: SpendLedger, endpoint: str | None = None, thinking: bool = False, step_log: Path | None = None
    ) -> None:
        river = _import_river()
        self._river = river
        self._api_key = api_key
        self._ledger = ledger
        self._thinking = thinking
        self._client = river.Client(api_key=api_key, endpoint=endpoint) if endpoint else river.Client(api_key=api_key)
        self._datasets: dict[str, list[SftExample]] = {}
        self._renderers: dict[str, Any] = {}
        self._step_log = step_log

    @classmethod
    def from_env(
        cls, ledger: SpendLedger, endpoint: str | None = None, thinking: bool = False, step_log: Path | None = None
    ) -> "RiverBackend":
        return cls(read_api_key(), ledger, endpoint, thinking, step_log)

    def close(self) -> None:
        self._client.close()

    def renderer(self, base_model: str) -> Any:
        if base_model not in self._renderers:
            from river_client.renderers import get_renderer

            self._renderers[base_model] = get_renderer(base_model, thinking=self._thinking)
        return self._renderers[base_model]

    def _prompt(self, base_model: str, system: str, user: str) -> str:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        return str(self.renderer(base_model).build_sample_prompt(messages).prompt)

    def count_tokens(self, base_model: str, text: str) -> int:
        return len(self.renderer(base_model).tokenizer.encode(text, add_special_tokens=False))

    def _record_samples(self, model: str, label: str, prompt: str, samples: Sequence[Any]) -> None:
        """OBSERVED: Client.sample reports prompt_tokens=0, so a zero count is replaced by a local tokenizer count."""
        local = self.count_tokens(model, prompt)
        prompt_tokens = sum(s.prompt_tokens or local for s in samples)
        cached = sum(s.cached_prompt_tokens or 0 for s in samples)
        completion = sum(len(s.tokens) for s in samples)
        self._ledger.record(Usage(model, label, prompt_tokens=prompt_tokens, cached_prompt_tokens=cached, completion_tokens=completion))

    def sample_raw(self, target: "ModelRef", prompt: str, *, n: int, max_tokens: int, temperature: float, seed: int, label: str) -> list[Any]:
        """One River sampling call on a rendered prompt. Returns River Sample objects (text, tokens, stop_reason, ...)."""
        self._ledger.check(Usage(target.base_model, label, prompt_tokens=estimate_tokens(prompt) * n, completion_tokens=max_tokens * n))
        stop = self.renderer(target.base_model).get_stop_strings()
        kwargs = {"num_samples": n, "max_tokens": max_tokens, "temperature": temperature, "seed": seed, "stop": stop}
        if target.checkpoint is None:
            samples = list(self._client.sample(prompt, base_model=target.base_model, **kwargs))
        else:
            checkpoint = target.checkpoint.inference_path or target.checkpoint.training_path
            with self._client.session() as session:
                groups = session.sample(prompt, base_model=target.base_model, checkpoint=checkpoint, **kwargs)
            samples = list(groups[0])
        self._record_samples(target.base_model, label, prompt, samples)
        return samples

    def upload_dataset(self, name: str, examples: Sequence[SftExample]) -> DatasetHandle:
        """CONFIRMED: River has no dataset upload. Batches travel with each forward_backward call, so this stages locally."""
        require_nonempty(name, examples)
        self._datasets[name] = list(examples)
        return DatasetHandle(name=name, n_examples=len(examples))

    def _sft_datum(self, base_model: str, example: SftExample) -> dict[str, Any]:
        messages = [
            {"role": "system", "content": example.system},
            {"role": "user", "content": example.user},
            {"role": "assistant", "content": example.completion},
        ]
        return dict(self.renderer(base_model).build_training_example(messages).to_dict())

    def _save(self, model: Any, name: str, base_model: str) -> CheckpointRef:
        training = model.save_weights(f"{name}-training", mode="training")
        inference = model.save_weights(f"{name}-inference", mode="inference")
        return CheckpointRef(training_path=training.path, inference_path=inference.path, base_model=base_model)

    def start_sft(self, dataset: DatasetHandle, config: SftConfig) -> CheckpointRef:
        """Blocking SFT loop, as in docs.river.ai/guides/sft/, with batches built by River's own renderer."""
        examples = self._datasets.get(dataset.name)
        if examples is None:
            raise KeyError(f"dataset {dataset.name!r} was not staged with upload_dataset")
        data = [self._sft_datum(config.base_model, ex) for ex in examples]
        batches = [(data[(s * config.batch_size) % len(data) :] + data)[: config.batch_size] for s in range(config.steps)]
        step_tokens = [sum(len(d["input_ids"]) for d in b) for b in batches]
        self._ledger.check(Usage(config.base_model, f"sft:{config.name}", training_tokens=sum(step_tokens)))
        river = self._river
        with self._client.session(project=config.name) as session:
            model = session.create_model(
                base_model=config.base_model,
                lora=river.LoraConfig(rank=config.lora_rank),
                checkpoint=config.init_checkpoint.training_path if config.init_checkpoint else None,
            )
            for batch, tokens in zip(batches, step_tokens, strict=True):
                model.forward_backward(batch, loss_fn="cross_entropy")
                model.optim_step(lr=config.lr, grad_clip_norm=1.0)
                self._ledger.record(Usage(config.base_model, f"sft:{config.name}", training_tokens=tokens))
            return self._save(model, config.name, config.base_model)

    def rl_worst_case(self, rows: Sequence[RlRow], config: RlConfig) -> Usage:
        prompt = max(estimate_tokens(self._prompt(config.base_model, r.system, r.user)) for r in rows)
        rollouts = config.steps * config.groups_per_step * config.group_size
        return Usage(
            config.base_model,
            f"rl:{config.name}",
            prompt_tokens=rollouts * prompt,
            completion_tokens=rollouts * config.max_generated_tokens,
            training_tokens=rollouts * (prompt + config.max_generated_tokens),
        )

    def run_rl(self, rows: Sequence[RlRow], reward_fn: RewardFn, config: RlConfig) -> CheckpointRef:
        """GRPO-style group centering with the CISPO loss, via river_client.rl (docs.river.ai/guides/rl-sync/).

        The whole run's worst case is checked against the cap before it starts. Each step's trajectories are
        recorded as they complete (prompt, generated and trained tokens), and the next step is refused if the
        cap has been reached. The reward runs in this process through asyncio.to_thread.
        """
        require_nonempty(config.name, rows)
        self._ledger.check(self.rl_worst_case(rows, config))
        river = self._river
        from river_client import rl
        from river_client.renderers import get_text_content

        by_id = {row.row_id: row for row in rows}
        ledger = self._ledger
        label = f"rl:{config.name}"

        class ReaderEnv(rl.Env):  # type: ignore[misc, name-defined]
            recovery = "stateless"

            async def reset(self, row: dict[str, str]) -> list[Any]:
                return [{"role": "system", "content": row["system"]}, {"role": "user", "content": row["user"]}]

            async def reward(self, traj: Any, row: dict[str, str]) -> float:
                completion = get_text_content(traj.messages[-1])
                return float(await asyncio.to_thread(reward_fn, by_id[row["row_id"]], completion))

        def on_step(step: Any) -> None:
            generated = sum(t.generated_tokens for t in step.trajectories)
            context = sum(t.context_tokens for t in step.trajectories)
            ledger.record(Usage(config.base_model, label, prompt_tokens=context - generated, completion_tokens=generated, training_tokens=context))
            entry = {"run": config.name, "n": step.n, "model_step": step.model_step, **dict(step.metrics)}
            self.last_rl_steps.append(entry)
            if self._step_log is not None:
                self._step_log.parent.mkdir(parents=True, exist_ok=True)
                with self._step_log.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry, default=str) + "\n")
            if ledger.remaining <= 0:
                raise SpendCapExceeded(f"{label}: cap reached after step {step.n}")

        renderer = self.renderer(config.base_model)
        dataset = [{"row_id": r.row_id, "system": r.system, "user": r.user} for r in rows]
        self.last_rl_steps: list[dict[str, Any]] = []
        with self._client.session(experiment=config.name) as session:
            model = session.create_model(
                base_model=config.base_model,
                tokenizer=renderer.tokenizer,
                lora=river.LoraConfig(rank=config.lora_rank, seed=config.seed),
                checkpoint=config.init_checkpoint.training_path if config.init_checkpoint else None,
            )
            engine = rl.RolloutEngine(
                model,
                env=ReaderEnv,
                renderer=renderer,
                budget=rl.Budget(
                    max_turns=1, max_generated_tokens=config.max_generated_tokens, max_context_tokens=config.max_context_tokens
                ),
                schedule=rl.Schedule(concurrency=config.group_size * config.groups_per_step),
                temperature=config.temperature,
                seed=config.seed,
            )
            trainer = rl.AsyncTrainer(
                engine=engine,
                optimizer=rl.Adam(lr=config.lr),
                advantage=rl.GroupCentered(),
                completion=rl.GroupCompletion(mode="wait"),
                normalize="token",
                loss="cispo",
                groups_per_step=config.groups_per_step,
                group_size=config.group_size,
                max_staleness=0,
            )
            rl.run(trainer, dataset, steps=config.steps, on_step=on_step)
            return self._save(model, config.name, config.base_model)

    def deploy(self, checkpoint: CheckpointRef) -> Endpoint:
        """Gated by River: needs a team API key with deployment access. Personal keys cannot deploy."""
        if checkpoint.inference_path is None:
            raise ValueError("deployment needs an inference-mode checkpoint (save_weights mode='inference')")
        deployment = self._client.create_deployment(
            checkpoint=checkpoint.inference_path,
            unified_replicas=1,
            idempotency_key=checkpoint.inference_path,
            wait=True,
        )
        return Endpoint(base_url=deployment.base_url, model=deployment.model)

    def sample(
        self, target: SampleTarget, *, system: str, user: str, n: int, max_tokens: int, temperature: float, seed: int
    ) -> list[str]:
        if isinstance(target, Endpoint):
            raise UnconfirmedRiverFeature(
                "UNCONFIRMED: token accounting for deployment endpoints is not implemented, so the spend cap cannot guard it. "
                "Sample the checkpoint with ModelRef instead."
            )
        prompt = self._prompt(target.base_model, system, user)
        samples = self.sample_raw(target, prompt, n=n, max_tokens=max_tokens, temperature=temperature, seed=seed, label="sample")
        return [s.text for s in samples]

    def llm_client(self, base_model: str, *, max_tokens: int, label: str, temperature: float = 0.0) -> "RiverLlmClient":
        return RiverLlmClient(self, base_model, max_tokens=max_tokens, label=label, temperature=temperature)

    def download_adapter(self, checkpoint: CheckpointRef, dest: Path) -> Path:
        raise UnconfirmedRiverFeature(
            "UNCONFIRMED: River documents no programmatic adapter download. Per docs.river.ai/guides/operations/, "
            "open the River Console, go to Checkpoints, select the inference checkpoint "
            f"({checkpoint.inference_path}), and use its download action. The file is a PEFT LoRA adapter for "
            f"{checkpoint.base_model}."
        )


class RiverLlmClient:
    """LlmClient for the verifier and base-rate judge: one client.sample call on a base model, no training."""

    def __init__(self, backend: RiverBackend, base_model: str, *, max_tokens: int, label: str, temperature: float = 0.0) -> None:
        self._backend = backend
        self._model = ModelRef(base_model)
        self._max_tokens = max_tokens
        self._label = label
        self._temperature = temperature
        self.calls = 0

    def complete(self, system: str, user: str) -> str:
        prompt = self._backend._prompt(self._model.base_model, system, user)
        [sample] = self._backend.sample_raw(
            self._model, prompt, n=1, max_tokens=self._max_tokens, temperature=self._temperature, seed=0, label=self._label
        )
        self.calls += 1
        if sample.stop_reason == "length":
            raise TruncatedResponseError(f"{self._label}: response hit max_tokens={self._max_tokens}; raise it or shrink the batch")
        return str(sample.text)
