"""Run 3: per-read credit assignment with River primitives (model.sample -> own per-token advantages ->
forward_backward(loss_fn="cispo") -> optim_step), instead of rl.run with one reward per deck.

The benchmark metric is unchanged from run 2. The restatement penalty is a training-only shaping term.
"""

import json
import random
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from pydantic import ValidationError

from nailed_it_training.episodes import Episode
from nailed_it_training.eval import ScoredDeck
from nailed_it_training.ledger import SpendLedger, Usage
from nailed_it_training.per_read import (
    AlignmentError,
    DeckCredit,
    ElementCredit,
    align_reads,
    assign_advantages,
    char_offsets,
    locate_read_elements,
    token_bytes,
    training_reward,
)
from nailed_it_training.pipeline import DeckScorer
from nailed_it_training.protocol import Read
from nailed_it_training.reader import _DraftRead
from nailed_it_training.reward import RewardConfig
from nailed_it_training.river_adapter import CheckpointRef


class SampleLike(Protocol):
    tokens: list[int]
    logprobs: list[float]
    stop_reason: str
    token_data_is_exact: bool


class Policy(Protocol):
    def sample(self, prompt_ids: list[int], *, n: int, seed: int) -> Sequence[SampleLike]: ...

    def train(self, batch: list[dict[str, Any]]) -> None: ...

    def save(self, name: str) -> CheckpointRef: ...


class TokenizerLike(Protocol):
    def convert_ids_to_tokens(self, i: int) -> str: ...


@dataclass(frozen=True)
class Run3Config:
    steps: int = 15
    checkpoints: tuple[int, ...] = (5, 10, 15)
    group_size: int = 8
    groups_per_step: int = 4
    workers: int = 8
    seed: int = 0
    restatement_penalty: float = -0.1
    deck_weight: float = 0.2
    deck_clip: float = 0.3
    malformed_reward: float = -2.0
    spend_guard: float = 33.7
    name: str = "nailed-run3"


def epoch_schedule(episode_ids: Sequence[str], *, steps: int, per_step: int, seed: int) -> list[list[str]]:
    """Seeded shuffle each epoch; consecutive slices of per_step episodes. Every episode appears once per epoch."""
    rng = random.Random(seed)
    queue: list[str] = []
    schedule = []
    for _ in range(steps):
        batch: list[str] = []
        while len(batch) < per_step:
            if not queue:
                queue = list(episode_ids)
                rng.shuffle(queue)
            candidate = queue.pop(0)
            if candidate in batch:
                queue.append(candidate)
                continue
            batch.append(candidate)
        schedule.append(batch)
    return schedule


@dataclass
class MatchedStop:
    """Stop rules on episode-matched deltas (each episode compared with its own previous visit)."""

    run_length: int = 5
    unverifiable_margin: float = 0.15
    spend_guard: float = 33.7
    _ig_run: int = 0
    _unv_run: int = 0

    def update(self, *, ig_delta: float | None, unverifiable_delta: float | None, spent: float) -> str | None:
        if spent >= self.spend_guard:
            return f"spend ${spent:.2f} reached the ${self.spend_guard:.2f} guard"
        if ig_delta is not None:
            self._ig_run = self._ig_run + 1 if ig_delta < 0 else 0
        if unverifiable_delta is not None:
            self._unv_run = self._unv_run + 1 if unverifiable_delta > self.unverifiable_margin else 0
        if self._ig_run >= self.run_length:
            return f"episode-matched information gain fell for {self.run_length} consecutive steps"
        if self._unv_run >= self.run_length:
            return f"episode-matched unverifiable share rose more than {self.unverifiable_margin} for {self.run_length} steps"
        return None


@dataclass
class RunResult:
    steps_done: int
    stop_reason: str | None
    checkpoints: list[dict[str, Any]] = field(default_factory=list)
    final: CheckpointRef | None = None


@dataclass
class _Rollout:
    episode_id: str
    prompt_ids: list[int]
    sample: SampleLike
    credit: DeckCredit | None = None
    scored: ScoredDeck | None = None
    malformed: bool = False
    misaligned: bool = False
    inexact: bool = False


def _validate_elements(text: str, spans: Sequence[tuple[int, int]], model_version: str) -> list[Read | None]:
    decoder = json.JSONDecoder(strict=False)
    reads: list[Read | None] = []
    for start, end in spans:
        try:
            draft = _DraftRead.model_validate(decoder.decode(text[start:end]))
            reads.append(Read(**draft.model_dump(), model_version=model_version))
        except (ValidationError, json.JSONDecodeError, TypeError):
            reads.append(None)
    return reads


class Trainer:
    def __init__(
        self,
        policy: Policy,
        tokenizer: TokenizerLike,
        scorer: DeckScorer,
        episodes: Mapping[str, Episode],
        prompts: Mapping[str, list[int]],
        config: Run3Config,
        *,
        metrics_path: Path,
        ledger: SpendLedger | None = None,
        reward_config: RewardConfig | None = None,
    ) -> None:
        self.policy = policy
        self.tokenizer = tokenizer
        self.scorer = scorer
        self.episodes = episodes
        self.prompts = prompts
        self.config = config
        self.metrics_path = metrics_path
        self.ledger = ledger
        self.reward_config = reward_config or RewardConfig()
        self.last_ig: dict[str, float] = {}
        self.last_unv: dict[str, float] = {}

    def _credit(self, rollout: _Rollout) -> None:
        sample = rollout.sample
        n_tokens = len(sample.tokens)
        if not sample.token_data_is_exact or len(sample.logprobs) != n_tokens:
            rollout.inexact = True
            return
        pieces = token_bytes(self.tokenizer, sample.tokens)
        malformed = DeckCredit(elements=[], deck_term=0.0, n_tokens=n_tokens, malformed_reward=self.config.malformed_reward)
        if sample.stop_reason == "length":
            rollout.malformed, rollout.credit = True, malformed
            return
        try:
            text, _ = char_offsets(pieces)
            spans = locate_read_elements(text)
        except AlignmentError:
            rollout.malformed, rollout.credit = True, malformed
            return
        try:
            ranges = align_reads(pieces)
        except AlignmentError:
            rollout.misaligned = True
            return
        reads = _validate_elements(text, spans, self.config.name)
        valid = [r for r in reads if r is not None]
        scored = self.scorer.score(self.episodes[rollout.episode_id], valid, n_invalid=len(reads) - len(valid))
        rollout.scored = scored
        by_valid = iter(scored.reads)
        elements = []
        for read, token_range in zip(reads, ranges, strict=True):
            if read is None:
                elements.append(ElementCredit(self.reward_config.invalid_read_penalty, None, None, token_range))
                continue
            s = next(by_valid)
            reward = training_reward(s.reward, s.gate, outcome=s.outcome, restatement_penalty=self.config.restatement_penalty)
            elements.append(ElementCredit(reward, read.category, s.gate, token_range))
        deck = scored.reward
        cfg = self.reward_config
        deck_term = -cfg.redundancy_weight * deck.redundancy + cfg.coverage_weight * deck.coverage - deck.size_penalty
        rollout.credit = DeckCredit(elements=elements, deck_term=deck_term, n_tokens=n_tokens)

    def _datum(self, rollout: _Rollout, advantages: list[float], whole: bool) -> dict[str, Any]:
        prompt, sample = rollout.prompt_ids, rollout.sample
        pad = [0.0] * (len(prompt) - 1)
        return {
            "input_ids": list(prompt) + list(sample.tokens),
            "attention_mask": [1] * (len(prompt) + len(sample.tokens)),
            "old_logprobs": pad + list(sample.logprobs) + [0.0],
            "advantages": pad + advantages + [0.0],
            "_completion": list(sample.tokens),
            "_whole_sequence": whole,
        }

    def _metrics(self, step: int, rollouts: list[_Rollout], trained: int, stop: str | None, usage: dict[str, Any]) -> dict[str, Any]:
        per_episode: dict[str, list[ScoredDeck]] = {}
        for r in rollouts:
            if r.scored is not None:
                per_episode.setdefault(r.episode_id, []).append(r.scored)
        ep_ig: dict[str, float] = {}
        ep_unv: dict[str, float] = {}
        all_reads = []
        for eid, decks in per_episode.items():
            reads = [s for d in decks for s in d.reads]
            all_reads.extend(reads)
            if reads:
                ep_ig[eid] = sum(s.reward for s in reads if s.outcome is not None) / len(reads)
                passed = [s for s in reads if s.gate.value == "passed"]
                if passed:
                    ep_unv[eid] = sum(s.outcome is None for s in passed) / len(passed)
        ig_deltas = [ep_ig[e] - self.last_ig[e] for e in ep_ig if e in self.last_ig]
        unv_deltas = [ep_unv[e] - self.last_unv[e] for e in ep_unv if e in self.last_unv]
        self.last_ig.update(ep_ig)
        self.last_unv.update(ep_unv)
        n = len(all_reads) or 1
        passed_all = [s for s in all_reads if s.gate.value == "passed"]
        return {
            "at": datetime.now(UTC).isoformat(),
            "run": self.config.name,
            "n": step,
            "episodes": sorted(per_episode),
            "n_decks": len(rollouts),
            "n_trained_decks": trained,
            "n_malformed": sum(r.malformed for r in rollouts),
            "n_misaligned": sum(r.misaligned for r in rollouts),
            "n_inexact": sum(r.inexact for r in rollouts),
            "n_invalid_reads": sum(r.scored.n_invalid for r in rollouts if r.scored is not None),
            "mean_information_gain": sum(s.reward for s in all_reads if s.outcome is not None) / n,
            "share_restatement": sum(s.gate.value == "restatement" for s in all_reads) / n,
            "share_ungrounded": sum(s.gate.value == "ungrounded" for s in all_reads) / n,
            "share_unverifiable": sum(s.outcome is None for s in passed_all) / len(passed_all) if passed_all else None,
            "share_supported": sum(s.outcome == 1 for s in all_reads) / n,
            "mean_distance_weight": sum(s.distance_weight for s in all_reads) / n,
            "mean_confidence": sum(s.read.confidence for s in all_reads) / n,
            "per_episode_ig": ep_ig,
            "matched_ig_delta": sum(ig_deltas) / len(ig_deltas) if ig_deltas else None,
            "matched_unverifiable_delta": sum(unv_deltas) / len(unv_deltas) if unv_deltas else None,
            **usage,
            "spent_usd": self.ledger.spent if self.ledger is not None else None,
            "stop_reason": stop,
        }

    def _sample_group(self, episode_id: str, step: int) -> list[_Rollout]:
        prompt = self.prompts[episode_id]
        samples = self.policy.sample(prompt, n=self.config.group_size, seed=self.config.seed * 1000 + step)
        return [_Rollout(episode_id, prompt, s) for s in samples]

    def run(self) -> RunResult:
        cfg = self.config
        schedule = epoch_schedule(sorted(self.episodes), steps=cfg.steps, per_step=cfg.groups_per_step, seed=cfg.seed)
        stop_rule = MatchedStop(spend_guard=cfg.spend_guard)
        result = RunResult(steps_done=0, stop_reason=None)
        self.metrics_path.parent.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=cfg.workers) as pool:
            for step, episode_ids in enumerate(schedule, start=1):
                sampled = list(pool.map(lambda eid, step=step: self._sample_group(eid, step), episode_ids))
                rollouts = [r for group in sampled for r in group]
                list(pool.map(self._credit, rollouts))
                batch: list[dict[str, Any]] = []
                credited_groups = [[r for r in g if r.credit is not None] for g in sampled]
                total_tokens = 0
                advantages_by_group = []
                for group in credited_groups:
                    adv = assign_advantages([r.credit for r in group if r.credit], deck_weight=cfg.deck_weight, deck_clip=cfg.deck_clip)
                    advantages_by_group.append(adv)
                    total_tokens += adv.normaliser if group else 0
                for group, adv in zip(credited_groups, advantages_by_group, strict=True):
                    if not group:
                        continue
                    scale = adv.normaliser / max(1, total_tokens)
                    for rollout, vec, whole in zip(group, adv.token_vectors(), adv.whole_sequence, strict=True):
                        if any(v != 0.0 for v in vec):
                            batch.append(self._datum(rollout, [v * scale for v in vec], whole is not None))
                usage = {"tokens_prompt": sum(len(r.prompt_ids) for r in rollouts), "tokens_completion": sum(len(r.sample.tokens) for r in rollouts)}
                if batch:
                    self.policy.train(batch)
                spent = self.ledger.spent if self.ledger is not None else 0.0
                row = self._metrics(step, rollouts, len(batch), None, usage)
                reason = stop_rule.update(ig_delta=row["matched_ig_delta"], unverifiable_delta=row["matched_unverifiable_delta"], spent=spent)
                row["stop_reason"] = reason
                if step in cfg.checkpoints or reason is not None:
                    ckpt = self.policy.save(f"{cfg.name}-step{step:03d}")
                    result.checkpoints.append({"step": step, **asdict(ckpt)})
                with self.metrics_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(row, default=str) + "\n")
                result.steps_done = step
                if reason is not None:
                    result.stop_reason = reason
                    break
        return result


class RiverPolicy:
    """Policy backed by a live River LoRA model: exact sampled tokens and logprobs, CISPO updates, metered spend."""

    def __init__(self, backend: Any, model: Any, base_model: str, ledger: SpendLedger, *, max_tokens: int, lr: float, stop: list[str]) -> None:
        self.backend = backend
        self.model = model
        self.base_model = base_model
        self.ledger = ledger
        self.max_tokens = max_tokens
        self.lr = lr
        self.stop = stop

    def sample(self, prompt_ids: list[int], *, n: int, seed: int) -> Sequence[SampleLike]:
        label = "run3:sample"
        self.ledger.check(Usage(self.base_model, label, prompt_tokens=len(prompt_ids) * n, completion_tokens=self.max_tokens * n))
        groups = self.model.sample(
            prompt_token_ids=prompt_ids,
            num_samples=n,
            max_tokens=self.max_tokens,
            temperature=1.0,
            top_p=1.0,
            top_k=-1,
            stop=self.stop,
            seed=seed,
        )
        samples = list(groups[0])
        completion = sum(len(s.tokens) for s in samples)
        self.ledger.record(Usage(self.base_model, label, prompt_tokens=len(prompt_ids) * n, completion_tokens=completion))
        return samples

    def train(self, batch: list[dict[str, Any]]) -> None:
        data = [{k: v for k, v in d.items() if not k.startswith("_")} for d in batch]
        tokens = sum(len(d["input_ids"]) for d in data)
        label = "run3:train"
        self.ledger.check(Usage(self.base_model, label, training_tokens=tokens))
        for start in range(0, len(data), 8):
            self.model.forward_backward(data[start : start + 8], loss_fn="cispo", eps_max=6.0, zero_out=start == 0)
        self.model.optim_step(lr=self.lr, beta1=0.9, beta2=0.95, eps=1e-8, weight_decay=0.0, grad_clip_norm=1.0)
        self.ledger.record(Usage(self.base_model, label, training_tokens=tokens))

    def save(self, name: str) -> CheckpointRef:
        return self.backend._save(self.model, name, self.base_model)
