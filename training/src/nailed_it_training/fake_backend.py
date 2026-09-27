"""In-process stand-in for a trainer backend. Proves pipeline wiring, not model quality.

The "model" is a categorical distribution over read-writing strategies. SFT moves it toward the
strategy mix of its dataset. RL runs group-centered REINFORCE on the strategy logits using rewards
from the caller's reward function, the same contract River's rl.Env.reward has.
"""

import hashlib
import json
import math
import random
from collections import Counter
from collections.abc import Sequence
from enum import StrEnum
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from nailed_it_training.protocol import ReadCategory
from nailed_it_training.river_adapter import (
    CheckpointRef,
    DatasetHandle,
    Endpoint,
    ModelRef,
    RewardFn,
    RlConfig,
    RlRow,
    SampleTarget,
    SftConfig,
    SftExample,
    require_nonempty,
)
from nailed_it_training.synthetic.lexicon import LEXICON, Prevalence, Trait

FAKE_BASE = "fake/base"
FAKE_TEACHER = "fake/teacher"
DECK_SIZE = 6
SFT_PRIOR_STRENGTH = 5.0
_EVIDENCE_MARKER = "Evidence items (JSON):\n"


class Strategy(StrEnum):
    GENERIC = "generic"
    RESTATE = "restate"
    INFER = "infer"
    BOLD = "bold"
    GUESS = "guess"
    FABRICATE = "fabricate"


STRATEGIES: list[Strategy] = list(Strategy)
Logits = NDArray[np.float64]

_INITIAL_PROBS: dict[str, dict[Strategy, float]] = {
    FAKE_BASE: {
        Strategy.GENERIC: 0.35,
        Strategy.RESTATE: 0.2,
        Strategy.INFER: 0.15,
        Strategy.BOLD: 0.05,
        Strategy.GUESS: 0.15,
        Strategy.FABRICATE: 0.1,
    },
    FAKE_TEACHER: {
        Strategy.GENERIC: 0.15,
        Strategy.RESTATE: 0.1,
        Strategy.INFER: 0.3,
        Strategy.BOLD: 0.25,
        Strategy.GUESS: 0.15,
        Strategy.FABRICATE: 0.05,
    },
}


def _logits(probs: dict[Strategy, float]) -> Logits:
    return np.log(np.array([probs[s] for s in STRATEGIES], dtype=np.float64))


def _softmax(logits: Logits, temperature: float = 1.0) -> Logits:
    z = logits / temperature
    e = np.exp(z - z.max())
    return e / e.sum()


def _stable_seed(*parts: object) -> int:
    return int.from_bytes(hashlib.blake2b(repr(parts).encode(), digest_size=8).digest(), "little")


def _visible_evidence(user: str) -> list[dict[str, str]]:
    if _EVIDENCE_MARKER not in user:
        return []
    parsed = json.loads(user.split(_EVIDENCE_MARKER, 1)[1])
    return [{"id": e["id"], "text": e["text"]} for e in parsed]


def _supporting(evidence: list[dict[str, str]], trait: Trait) -> list[str]:
    return [e["id"] for e in evidence if any(p in e["text"].lower() for p in trait.support_phrases)]


def _read(read_id: str, text: str, category: ReadCategory, confidence: float, ids: list[str], hops: int) -> dict[str, object]:
    return {"id": read_id, "text": text[:240], "category": category.value, "confidence": confidence, "evidenceIds": ids, "hops": hops}


def _write_read(strategy: Strategy, index: int, evidence: list[dict[str, str]], rng: random.Random) -> dict[str, object]:
    read_id = f"{strategy.value}-{index}"
    any_id = [rng.choice(evidence)["id"]] if evidence else []
    evidenced = [(t, ids) for t in LEXICON if t.prevalence is not Prevalence.UNIVERSAL and (ids := _supporting(evidence, t))]
    consequences = [(c, ids) for t, ids in evidenced for c in LEXICON if c.signal == t.key]
    guessable = [t for t in LEXICON if t.prevalence is not Prevalence.UNIVERSAL]

    if strategy is Strategy.GENERIC:
        trait = rng.choice([t for t in LEXICON if t.prevalence is Prevalence.UNIVERSAL])
        return _read(read_id, trait.read_text, trait.category, 0.9, any_id, 2)
    if strategy is Strategy.RESTATE and evidence:
        item = rng.choice(evidence)
        return _read(read_id, item["text"], ReadCategory.WORK_STYLE, 0.95, [item["id"]], 0)
    if strategy is Strategy.INFER and evidenced:
        trait, ids = rng.choice(evidenced)
        return _read(read_id, trait.read_text, trait.category, 0.75, [rng.choice(ids)], 1)
    if strategy is Strategy.BOLD and consequences:
        trait, ids = rng.choice(consequences)
        return _read(read_id, trait.read_text, trait.category, 0.65, [rng.choice(ids)], 2)
    if strategy is Strategy.FABRICATE:
        trait = rng.choice(guessable)
        return _read(read_id, trait.read_text, trait.category, 0.8, ["fabricated-evidence-id"], 2)
    trait = rng.choice(guessable)
    return _read(read_id, trait.read_text, trait.category, 0.85, any_id, 2)


def _strategies_in(completion: str) -> list[Strategy]:
    parsed = json.loads(completion)
    if not isinstance(parsed, dict):
        raise ValueError(f"fake SFT completion must be a JSON object, got {type(parsed).__name__}")
    reads = parsed.get("reads", [])
    found = []
    for r in reads:
        prefix = str(r.get("id", "")).split("-", 1)[0]
        if prefix in Strategy.__members__.values():
            found.append(Strategy(prefix))
    return found


class FakeBackend:
    def __init__(self, seed: int) -> None:
        self._seed = seed
        self._policies: dict[str, Logits] = {base: _logits(p) for base, p in _INITIAL_PROBS.items()}
        self._datasets: dict[str, list[SftExample]] = {}
        self._endpoints: dict[str, str] = {}
        self.reward_history: dict[str, list[float]] = {}

    def _policy_key(self, target: SampleTarget) -> str:
        if isinstance(target, Endpoint):
            if target.base_url not in self._endpoints:
                raise KeyError(f"unknown fake endpoint {target.base_url}")
            return self._endpoints[target.base_url]
        key = target.checkpoint.training_path if target.checkpoint else target.base_model
        if key not in self._policies:
            raise KeyError(f"unknown fake model {key}")
        return key

    def _generate(self, logits: Logits, user: str, temperature: float, rng: random.Random) -> tuple[str, list[Strategy]]:
        evidence = _visible_evidence(user)
        probs = _softmax(logits, temperature)
        strategies = rng.choices(STRATEGIES, weights=probs.tolist(), k=DECK_SIZE)
        reads = [_write_read(s, i, evidence, rng) for i, s in enumerate(strategies)]
        return json.dumps({"reads": reads}), strategies

    def upload_dataset(self, name: str, examples: Sequence[SftExample]) -> DatasetHandle:
        require_nonempty(name, examples)
        self._datasets[name] = list(examples)
        return DatasetHandle(name=name, n_examples=len(examples))

    def start_sft(self, dataset: DatasetHandle, config: SftConfig) -> CheckpointRef:
        examples = self._datasets[dataset.name]
        start_key = config.init_checkpoint.training_path if config.init_checkpoint else config.base_model
        old = _softmax(self._policies[start_key])
        counts = Counter(s for ex in examples for s in _strategies_in(ex.completion))
        total = sum(counts.values())
        new = np.array([(counts[s] + SFT_PRIOR_STRENGTH * old[i]) / (total + SFT_PRIOR_STRENGTH) for i, s in enumerate(STRATEGIES)])
        return self._register(config.name, config.base_model, np.log(new))

    def run_rl(self, rows: Sequence[RlRow], reward_fn: RewardFn, config: RlConfig) -> CheckpointRef:
        require_nonempty(config.name, rows)
        start_key = config.init_checkpoint.training_path if config.init_checkpoint else config.base_model
        logits = self._policies[start_key].copy()
        history: list[float] = []
        for step in range(config.steps):
            grad = np.zeros_like(logits)
            step_rewards: list[float] = []
            for g in range(config.groups_per_step):
                row = rows[(step * config.groups_per_step + g) % len(rows)]
                probs = _softmax(logits, config.temperature)
                samples = []
                for j in range(config.group_size):
                    rng = random.Random(_stable_seed(self._seed, config.seed, config.name, step, row.row_id, j))
                    text, strategies = self._generate(logits, row.user, config.temperature, rng)
                    samples.append((reward_fn(row, text), strategies))
                rewards = [r for r, _ in samples]
                if not all(math.isfinite(r) for r in rewards):
                    raise ValueError(f"reward_fn returned a non-finite reward for row {row.row_id}: {rewards}")
                baseline = sum(rewards) / len(rewards)
                step_rewards.extend(rewards)
                for reward, strategies in samples:
                    for s in strategies:
                        onehot = np.zeros_like(logits)
                        onehot[STRATEGIES.index(s)] = 1.0
                        grad += (reward - baseline) * (onehot - probs)
            logits = logits + config.lr * grad / (config.group_size * config.groups_per_step)
            history.append(sum(step_rewards) / len(step_rewards))
        self.reward_history[config.name] = history
        return self._register(config.name, config.base_model, logits)

    def _register(self, name: str, base_model: str, logits: Logits) -> CheckpointRef:
        path = f"fake://{name}"
        self._policies[path] = logits
        return CheckpointRef(training_path=path, inference_path=path, base_model=base_model)

    def deploy(self, checkpoint: CheckpointRef) -> Endpoint:
        url = f"fake://deploy/{checkpoint.training_path.removeprefix('fake://')}"
        self._endpoints[url] = checkpoint.training_path
        return Endpoint(base_url=url, model=checkpoint.training_path)

    def sample(
        self, target: SampleTarget, *, system: str, user: str, n: int, max_tokens: int, temperature: float, seed: int
    ) -> list[str]:
        key = self._policy_key(target)
        logits = self._policies[key]
        return [
            self._generate(logits, user, temperature, random.Random(_stable_seed(self._seed, seed, key, user, i)))[0]
            for i in range(n)
        ]

    def strategy_probs(self, target: ModelRef) -> dict[Strategy, float]:
        probs = _softmax(self._policies[self._policy_key(target)])
        return {s: float(p) for s, p in zip(STRATEGIES, probs, strict=True)}

    def download_adapter(self, checkpoint: CheckpointRef, dest: Path) -> Path:
        dest.mkdir(parents=True, exist_ok=True)
        out = dest / f"{checkpoint.training_path.removeprefix('fake://').replace('/', '_')}.json"
        out.write_text(json.dumps({"strategy_logits": self._policies[checkpoint.training_path].tolist()}))
        return out
