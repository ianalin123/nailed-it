"""Trainer backend protocol and the River implementation.

Every River call below is copied from docs.river.ai (see docs/working/river-notes.md). Anything the
docs do not show is marked UNCONFIRMED and raises UnconfirmedRiverFeature instead of guessing.
This implementation has never been run: no API key was available when it was written.
"""

import asyncio
import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

RIVER_API_KEY_ENV = "RIVER_API_KEY"


class MissingApiKeyError(RuntimeError):
    pass


class RiverClientNotInstalled(RuntimeError):
    pass


class UnconfirmedRiverFeature(NotImplementedError):
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
    max_generated_tokens: int = 2048
    max_context_tokens: int = 8192
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
    """River Cloud backend. Holds the key in memory only."""

    def __init__(self, api_key: str, endpoint: str | None = None) -> None:
        river = _import_river()
        self._river = river
        self._api_key = api_key
        self._client = river.Client(api_key=api_key, endpoint=endpoint) if endpoint else river.Client(api_key=api_key)
        self._datasets: dict[str, list[SftExample]] = {}

    @classmethod
    def from_env(cls, endpoint: str | None = None) -> "RiverBackend":
        return cls(read_api_key(), endpoint)

    def close(self) -> None:
        self._client.close()

    def upload_dataset(self, name: str, examples: Sequence[SftExample]) -> DatasetHandle:
        """CONFIRMED: River has no dataset upload. Batches travel with each forward_backward call, so this stages locally."""
        require_nonempty(name, examples)
        self._datasets[name] = list(examples)
        return DatasetHandle(name=name, n_examples=len(examples))

    @staticmethod
    def _tokenizer(base_model: str) -> Any:
        from transformers import AutoTokenizer

        return AutoTokenizer.from_pretrained(base_model)

    @staticmethod
    def _prompt_ids(tokenizer: Any, system: str, user: str) -> list[int]:
        """UNCONFIRMED: that HF apply_chat_template matches River's renderer (used in RL) token for token."""
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        return list(tokenizer(text, add_special_tokens=False)["input_ids"])

    def _sft_datum(self, tokenizer: Any, example: SftExample) -> dict[str, list[Any]]:
        prompt_ids = self._prompt_ids(tokenizer, example.system, example.user)
        completion_ids = tokenizer(example.completion, add_special_tokens=False)["input_ids"] + [tokenizer.eos_token_id]
        ids = prompt_ids + completion_ids
        return {
            "input_ids": ids,
            "target_tokens": ids[1:] + [tokenizer.eos_token_id],
            "weights": [0.0] * (len(prompt_ids) - 1) + [1.0] * (len(completion_ids) + 1),
        }

    def _save(self, model: Any, name: str, base_model: str) -> CheckpointRef:
        training = model.save_weights(f"{name}-training", mode="training")
        inference = model.save_weights(f"{name}-inference", mode="inference")
        return CheckpointRef(training_path=training.path, inference_path=inference.path, base_model=base_model)

    def start_sft(self, dataset: DatasetHandle, config: SftConfig) -> CheckpointRef:
        """Blocking SFT loop, as in docs.river.ai/guides/sft/. River has no async SFT job API."""
        examples = self._datasets.get(dataset.name)
        if examples is None:
            raise KeyError(f"dataset {dataset.name!r} was not staged with upload_dataset")
        tokenizer = self._tokenizer(config.base_model)
        data = [self._sft_datum(tokenizer, ex) for ex in examples]
        river = self._river
        with self._client.session(project=config.name) as session:
            model = session.create_model(
                base_model=config.base_model,
                lora=river.LoraConfig(rank=config.lora_rank),
                checkpoint=config.init_checkpoint.training_path if config.init_checkpoint else None,
            )
            for step in range(config.steps):
                start = (step * config.batch_size) % len(data)
                batch = (data[start:] + data[:start])[: config.batch_size]
                model.forward_backward(batch, loss_fn="cross_entropy")
                model.optim_step(lr=config.lr, grad_clip_norm=1.0)
            return self._save(model, config.name, config.base_model)

    def run_rl(self, rows: Sequence[RlRow], reward_fn: RewardFn, config: RlConfig) -> CheckpointRef:
        """GRPO-style group centering with the CISPO loss, via river_client.rl (docs.river.ai/guides/rl-sync/).

        The reward runs in this process. It is invoked through asyncio.to_thread so a blocking verifier
        call does not stall the engine's event loop. UNCONFIRMED: that River's engine tolerates this.
        """
        require_nonempty(config.name, rows)
        river = self._river
        from river_client import rl
        from river_client.renderers import get_renderer, get_text_content

        by_id = {row.row_id: row for row in rows}

        class ReaderEnv(rl.Env):  # type: ignore[misc, name-defined]
            recovery = "stateless"

            async def reset(self, row: dict[str, str]) -> list[dict[str, str]]:
                return [{"role": "system", "content": row["system"]}, {"role": "user", "content": row["user"]}]

            async def reward(self, traj: Any, row: dict[str, str]) -> float:
                completion = get_text_content(traj.messages[-1])
                return float(await asyncio.to_thread(reward_fn, by_id[row["row_id"]], completion))

        renderer = get_renderer(config.base_model)
        dataset = [{"row_id": r.row_id, "system": r.system, "user": r.user} for r in rows]
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
            rl.run(trainer, dataset, steps=config.steps)
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
            return self._sample_endpoint(target, system=system, user=user, n=n, max_tokens=max_tokens, temperature=temperature)
        prompt_ids = self._prompt_ids(self._tokenizer(target.base_model), system, user)
        common = {"prompt_token_ids": prompt_ids, "num_samples": n, "max_tokens": max_tokens, "temperature": temperature, "seed": seed}
        if target.checkpoint is None:
            # Client.sample returns list[Sample] (docs); flat length-n for one prompt is UNCONFIRMED.
            return [s.text for s in self._client.sample(base_model=target.base_model, **common)]
        checkpoint = target.checkpoint.inference_path or target.checkpoint.training_path
        with self._client.session() as session:
            groups = session.sample(base_model=target.base_model, checkpoint=checkpoint, **common)
        return [s.text for s in groups[0]]

    def _sample_endpoint(self, endpoint: Endpoint, *, system: str, user: str, n: int, max_tokens: int, temperature: float) -> list[str]:
        """OpenAI-compatible deployment. Whether it honours `n` is UNCONFIRMED, so requests are issued one at a time."""
        from openai import OpenAI

        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        with OpenAI(api_key=self._api_key, base_url=endpoint.base_url) as client:
            texts = []
            for _ in range(n):
                response = client.chat.completions.create(
                    model=endpoint.model, messages=messages, max_tokens=max_tokens, temperature=temperature
                )
                content = response.choices[0].message.content
                if content is None:
                    raise RuntimeError(f"endpoint {endpoint.base_url} returned an empty message")
                texts.append(content)
            return texts

    def download_adapter(self, checkpoint: CheckpointRef, dest: Path) -> Path:
        raise UnconfirmedRiverFeature(
            "UNCONFIRMED: River documents no programmatic adapter download. Per docs.river.ai/guides/operations/, "
            "open the River Console, go to Checkpoints, select the inference checkpoint "
            f"({checkpoint.inference_path}), and use its download action. The file is a PEFT LoRA adapter for "
            f"{checkpoint.base_model}."
        )
