"""Stages A and B end to end, plus the frozen benchmark and the five-row ablation."""

import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from nailed_it_training.base_rate import BaseRateSource
from nailed_it_training.critic import AUDIT_MIN_OVERLAP, AuditResult, AuditStatus, Critic, audit_verifier, hashing_embedder
from nailed_it_training.distance import DistanceConfig, distance_weight, max_containment, needs_entailment_check
from nailed_it_training.episodes import Episode, EpisodeKind, SplitConfig, build_episodes
from nailed_it_training.eval import AblationRow, EvalMetrics, ScoredDeck, compute_metrics, render_ablation_table
from nailed_it_training.fake_backend import FAKE_BASE, FAKE_TEACHER
from nailed_it_training.ledger import SpendLedger
from nailed_it_training.protocol import EvidenceDigest, Read, VerdictRecord
from nailed_it_training.reader import MalformedDeckError, parse_deck, render_reader_prompt
from nailed_it_training.reward import DECK_SIZE, Gate, RewardConfig, ScoredRead, deck_reward, score_read
from nailed_it_training.river_adapter import (
    CheckpointRef,
    ModelRef,
    RlConfig,
    RlRow,
    SftConfig,
    SftExample,
    StepHook,
    StepInfo,
    StopTraining,
    TrainerBackend,
)
from nailed_it_training.verifier import HIDDEN_CAP, VerdictLabel, Verifier, is_restatement, select_relevant


class BenchmarkTamperedError(RuntimeError):
    pass


class BenchmarkLeakageError(RuntimeError):
    pass


class VerifierDistrustedError(RuntimeError):
    pass


class StageAStarvedError(RuntimeError):
    pass


@dataclass(frozen=True)
class PipelineConfig:
    seed: int = 0
    heldout_digest_ids: frozenset[str] = frozenset()
    time_window_fraction: float = 0.2
    split: SplitConfig = field(default_factory=lambda: SplitConfig(n_temporal=3))
    reward: RewardConfig = field(default_factory=RewardConfig)
    teacher_decks_per_episode: int = 2
    eval_samples_per_episode: int = 4
    sft_steps: int = 20
    rl_steps: int = 20
    group_size: int = 8
    groups_per_step: int = 4
    rl_lr: float = 0.5
    temperature: float = 1.0
    max_tokens: int = 2048
    malformed_reward: float = -2.0
    require_audit: bool = False
    min_audit_overlap: int = AUDIT_MIN_OVERLAP
    base_model: str = FAKE_BASE
    teacher_model: str = FAKE_TEACHER


@dataclass(frozen=True)
class FrozenBenchmark:
    episodes: tuple[Episode, ...]
    fingerprint: str


@dataclass(frozen=True)
class StageAResult:
    raw_examples: tuple[SftExample, ...]
    verified_examples: tuple[SftExample, ...]
    survivors: tuple[ScoredRead, ...]
    n_teacher_reads: int
    n_malformed: int
    n_skipped_episodes: int = 0


@dataclass(frozen=True)
class PipelineResult:
    table: str
    metrics: dict[AblationRow, EvalMetrics]
    stage_a: StageAResult
    audit: AuditResult | None
    critic_trained: bool
    reward_history: dict[AblationRow, list[float]]
    benchmark_digest_ids: frozenset[str]
    training_digest_ids: frozenset[str]


def _fingerprint(episodes: Sequence[Episode]) -> str:
    payload = [(e.episode_id, [i.id for i in e.visible], [i.id for i in e.hidden]) for e in episodes]
    return hashlib.sha256(json.dumps(payload).encode()).hexdigest()


def freeze_benchmark(episodes: Sequence[Episode]) -> FrozenBenchmark:
    if not episodes:
        raise ValueError("a benchmark needs at least one episode")
    return FrozenBenchmark(episodes=tuple(episodes), fingerprint=_fingerprint(episodes))


def verify_frozen(benchmark: FrozenBenchmark) -> None:
    if _fingerprint(benchmark.episodes) != benchmark.fingerprint:
        raise BenchmarkTamperedError("benchmark episodes changed after freezing")


def assert_no_leakage(benchmark: FrozenBenchmark, training_episodes: Sequence[Episode]) -> None:
    held_out = {i.id for e in benchmark.episodes for i in e.hidden}
    seen = {i.id for e in training_episodes for i in (*e.visible, *e.hidden)}
    leaked = held_out & seen
    if leaked:
        raise BenchmarkLeakageError(f"{len(leaked)} benchmark hidden items appear in training episodes, e.g. {sorted(leaked)[:3]}")


def hold_out_time_window(digest: EvidenceDigest, *, fraction: float, min_hidden: int) -> tuple[EvidenceDigest, Episode | None]:
    """Remove the latest `fraction` of dated items from training. Undated items stay in training (see README caveat)."""
    if not 0.0 < fraction < 1.0:
        raise ValueError(f"fraction must be in (0, 1), got {fraction}")
    dated = sorted((i for i in digest.items if i.observed_at is not None), key=lambda i: (i.observed_at, i.id))
    undated = [i for i in digest.items if i.observed_at is None]
    k = math.floor(len(dated) * (1.0 - fraction))
    while 0 < k < len(dated) and dated[k - 1].observed_at == dated[k].observed_at:
        k += 1
    if k < 1 or len(dated) - k < min_hidden:
        return digest, None
    cutoff = dated[k].observed_at
    episode = Episode(
        episode_id=f"{digest.digest_id}:window:{cutoff.isoformat() if cutoff else ''}",
        digest_id=digest.digest_id,
        display_name=digest.display_name,
        kind=EpisodeKind.TEMPORAL,
        visible=tuple(dated[:k]),
        hidden=tuple(dated[k:]),
        cutoff=cutoff,
    )
    return digest.model_copy(update={"items": [*dated[:k], *undated]}), episode


class DeckScorer:
    """Scores a deck: one batched verifier call over the hidden side (capped by relevance), a lexical distance to the
    visible side for every read, and one batched entailment call over the visible side for reads in the
    distance config's check band. Hidden and visible selections are drawn separately and never mixed."""

    def __init__(
        self,
        verifier: Verifier,
        base_rates: BaseRateSource,
        config: RewardConfig,
        critic: Critic | None = None,
        evidence_cap: int = HIDDEN_CAP,
        distance: DistanceConfig | None = None,
    ) -> None:
        self._verifier = verifier
        self._base_rates = base_rates
        self._config = config
        self._critic = critic
        self._cap = evidence_cap
        self._distance = distance or DistanceConfig()

    def weights(self, episode: Episode, reads: Sequence[Read]) -> list[float]:
        sims = [max_containment(r.text, episode.visible)[0] for r in reads]
        weights = [distance_weight(s, self._distance) for s in sims]
        band = [i for i, s in enumerate(sims) if needs_entailment_check(s, self._distance)]
        if band and episode.visible:
            texts = [reads[i].text for i in band]
            visible = select_relevant(texts, episode.visible, k=self._cap)
            for i, verdict in zip(band, self._verifier.verify_many(texts, visible), strict=True):
                if is_restatement(verdict, self._config.min_verdict_strength):
                    weights[i] = 0.0
        return weights

    def score(self, episode: Episode, reads: Sequence[Read], n_invalid: int = 0) -> ScoredDeck:
        if not reads:
            return ScoredDeck(reads=(), reward=deck_reward([], [], self._config, n_invalid=n_invalid), n_invalid=n_invalid)
        texts = [r.text for r in reads]
        verdicts = self._verifier.verify_many(texts, select_relevant(texts, episode.hidden, k=self._cap))
        weights = self.weights(episode, reads)
        rates = self._base_rates.base_rates(reads, episode.digest_id)
        scored = tuple(
            score_read(
                read,
                visible_ids=episode.visible_ids,
                verdict=verdict,
                base_rate=rate,
                config=self._config,
                distance_weight=weight,
                critic=self._critic.predict(read) if self._critic else None,
            )
            for read, verdict, rate, weight in zip(reads, verdicts, rates, weights, strict=True)
        )
        reward = deck_reward(reads, [s.reward for s in scored], self._config, n_invalid=n_invalid)
        return ScoredDeck(reads=scored, reward=reward, n_invalid=n_invalid)


def _completion(reads: Sequence[Read]) -> str:
    return json.dumps({"reads": [r.model_dump(by_alias=True, exclude={"model_version"}, exclude_none=True) for r in reads]})


def assemble_decks(survivors: Sequence[ScoredRead], deck_size: int = DECK_SIZE) -> list[list[Read]]:
    """Distinct survivors (by normalised text), best reward first, cut into full decks of deck_size, re-numbered r1..rN."""
    unique: dict[str, ScoredRead] = {}
    for s in survivors:
        key = " ".join(s.read.text.lower().split())
        if key not in unique or s.reward > unique[key].reward:
            unique[key] = s
    ranked = sorted(unique.values(), key=lambda s: (-s.reward, s.read.text))
    decks = []
    for start in range(0, len(ranked) - deck_size + 1, deck_size):
        chunk = ranked[start : start + deck_size]
        decks.append([s.read.model_copy(update={"id": f"r{i}"}) for i, s in enumerate(chunk, start=1)])
    return decks


def run_stage_a(
    backend: TrainerBackend, scorer: DeckScorer, episodes: Sequence[Episode], config: PipelineConfig
) -> StageAResult:
    """Teacher writes decks; keep reads that pass the gates and verify with R > 0. Survivors of one episode are pooled
    and assembled into exact 12-read decks, matching RL. Episodes with fewer than 12 distinct survivors are skipped."""
    raw: list[SftExample] = []
    verified: list[SftExample] = []
    survivors: list[ScoredRead] = []
    n_reads = n_malformed = n_skipped = 0
    for episode in episodes:
        pooled: list[ScoredRead] = []
        system, user = render_reader_prompt(episode)
        texts = backend.sample(
            ModelRef(config.teacher_model),
            system=system,
            user=user,
            n=config.teacher_decks_per_episode,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            seed=config.seed,
        )
        for text in texts:
            try:
                reads = parse_deck(text, model_version=config.teacher_model).reads
            except MalformedDeckError:
                n_malformed += 1
                continue
            if not reads:
                n_malformed += 1
                continue
            n_reads += len(reads)
            raw.append(SftExample(system=system, user=user, completion=text))
            kept = [s for s in scorer.score(episode, reads).reads if s.gate is Gate.PASSED and s.outcome is not None and s.reward > 0]
            pooled.extend(kept)
        survivors.extend(pooled)
        decks = assemble_decks(pooled, config.reward.deck_size)
        if not decks:
            n_skipped += 1
        verified.extend(SftExample(system=system, user=user, completion=_completion(deck)) for deck in decks)
    return StageAResult(tuple(raw), tuple(verified), tuple(survivors), n_reads, n_malformed, n_skipped)


RewardFn = Callable[[RlRow, str], float]


class Telemetry:
    """Collects per-rollout reward statistics between RL steps. Thread-safe enough for River's to_thread rewards:
    list.append is atomic in CPython and drain swaps the list."""

    def __init__(self, capture: Path | None = None, capture_limit: int = 20) -> None:
        self._rows: list[dict[str, Any]] = []
        self._capture = capture
        self._capture_left = capture_limit

    def capture(self, kind: str, completion: str, errors: Sequence[str]) -> None:
        """Keep a bounded sample of failing completions for diagnosis (they may quote real evidence: .spend only)."""
        if self._capture is None or self._capture_left <= 0:
            return
        self._capture_left -= 1
        self._capture.parent.mkdir(parents=True, exist_ok=True)
        with self._capture.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"kind": kind, "errors": list(errors), "completion": completion}) + "\n")

    def record_deck(self, deck: ScoredDeck) -> None:
        reads = deck.reads
        n = len(reads) + deck.n_invalid
        passed = [r for r in reads if r.gate is Gate.PASSED]
        self._rows.append(
            {
                "reward": deck.reward.total,
                "information_gain": sum(r.reward for r in reads if r.outcome is not None) / n,
                "restatement": sum(r.gate is Gate.RESTATEMENT for r in reads) / n,
                "distance_weight": sum(r.distance_weight for r in reads) / len(reads) if reads else None,
                "ungrounded": sum(r.gate is Gate.UNGROUNDED for r in reads) / n,
                "invalid": deck.n_invalid / n,
                "unverifiable": sum(r.outcome is None for r in passed) / len(passed) if passed else None,
                "confidence": sum(r.read.confidence for r in reads) / len(reads) if reads else None,
                "n_reads": n,
                "malformed": False,
            }
        )

    def record_simple(self, reward: float, *, supported: float | None, unverifiable: float | None, confidence: float | None) -> None:
        self._rows.append(
            {"reward": reward, "supported": supported, "unverifiable": unverifiable, "confidence": confidence, "malformed": False}
        )

    def record_malformed(self, reward: float) -> None:
        self._rows.append({"reward": reward, "malformed": True})

    @staticmethod
    def _mean(rows: list[dict[str, Any]], key: str) -> float | None:
        values = [r[key] for r in rows if r.get(key) is not None]
        return sum(values) / len(values) if values else None

    def drain(self) -> dict[str, Any]:
        rows, self._rows = self._rows, []
        ok = [r for r in rows if not r["malformed"]]
        return {
            "n_decks": len(rows),
            "n_malformed": len(rows) - len(ok),
            "mean_reward": self._mean(rows, "reward"),
            "mean_information_gain": self._mean(ok, "information_gain"),
            "share_restatement": self._mean(ok, "restatement"),
            "mean_distance_weight": self._mean(ok, "distance_weight"),
            "share_ungrounded": self._mean(ok, "ungrounded"),
            "share_invalid": self._mean(ok, "invalid"),
            "share_unverifiable": self._mean(ok, "unverifiable"),
            "share_supported": self._mean(ok, "supported"),
            "mean_confidence": self._mean(ok, "confidence"),
        }


def information_gain_reward(
    scorer: DeckScorer, episodes: Mapping[str, Episode], config: PipelineConfig, telemetry: Telemetry | None = None
) -> RewardFn:
    def reward(row: RlRow, completion: str) -> float:
        try:
            parsed = parse_deck(completion, model_version="policy")
        except MalformedDeckError as err:
            if telemetry is not None:
                telemetry.record_malformed(config.malformed_reward)
                telemetry.capture("malformed", completion, [str(err)])
            return config.malformed_reward
        if parsed.errors and telemetry is not None:
            telemetry.capture("invalid_reads", completion, parsed.errors)
        deck = scorer.score(episodes[row.row_id], parsed.reads, n_invalid=len(parsed.errors))
        if telemetry is not None:
            telemetry.record_deck(deck)
        return deck.reward.total

    return reward


def correctness_reward(
    verifier: Verifier, episodes: Mapping[str, Episode], telemetry: Telemetry | None = None, evidence_cap: int = HIDDEN_CAP
) -> RewardFn:
    """The naive baseline: fraction of reads the verifier supports. No gates, no base rate."""

    def reward(row: RlRow, completion: str) -> float:
        try:
            parsed = parse_deck(completion, model_version="policy")
        except MalformedDeckError:
            if telemetry is not None:
                telemetry.record_malformed(0.0)
            return 0.0
        reads = parsed.reads
        n = len(reads) + len(parsed.errors)
        if not reads:
            if telemetry is not None:
                telemetry.record_simple(0.0, supported=0.0, unverifiable=None, confidence=None)
            return 0.0
        texts = [r.text for r in reads]
        verdicts = verifier.verify_many(texts, select_relevant(texts, episodes[row.row_id].hidden, k=evidence_cap))
        value = sum(v.label is VerdictLabel.SUPPORTED for v in verdicts) / n
        if telemetry is not None:
            unverifiable = sum(v.label is VerdictLabel.UNVERIFIABLE for v in verdicts) / len(reads)
            confidence = sum(r.confidence for r in reads) / len(reads)
            telemetry.record_simple(value, supported=value, unverifiable=unverifiable, confidence=confidence)
        return value

    return reward


@dataclass(frozen=True)
class StopPolicy:
    """Early stop relative to the run's own first step (run-2 change B):
    - unverifiable share more than `unverifiable_margin` above step 1's for `unverifiable_run` consecutive steps;
    - mean information gain (after the distance weight) below step 1's for `ig_run` consecutive steps;
    - spend at `spend_limit`.
    Steps with a missing value break a run. There is no absolute unverifiable threshold."""

    unverifiable_margin: float = 0.15
    unverifiable_run: int = 5
    ig_run: int = 10
    spend_limit: float = 45.0

    @staticmethod
    def _trailing(history: Sequence[Mapping[str, Any]], key: str, bad: Callable[[float], bool]) -> int:
        count = 0
        for h in reversed(history[1:]):
            value = h.get(key)
            if value is None or not bad(value):
                break
            count += 1
        return count

    def reason(self, history: Sequence[Mapping[str, Any]], spent: float) -> str | None:
        if spent >= self.spend_limit:
            return f"spend ${spent:.2f} reached the ${self.spend_limit:.2f} limit"
        if not history:
            return None
        first = history[0]
        u0 = first.get("share_unverifiable")
        if u0 is not None:
            limit = u0 + self.unverifiable_margin
            if self._trailing(history, "share_unverifiable", lambda v: v > limit) >= self.unverifiable_run:
                return f"unverifiable share above {limit:.2f} (step 1 + {self.unverifiable_margin}) for {self.unverifiable_run} steps"
        ig0 = first.get("mean_information_gain")
        if ig0 is not None and self._trailing(history, "mean_information_gain", lambda v: v < ig0) >= self.ig_run:
            return f"mean information gain below step 1's ({ig0:.3f}) for {self.ig_run} steps"
        return None


def metrics_hook(run: str, telemetry: Telemetry, path: Path, policy: StopPolicy, ledger: SpendLedger | None) -> StepHook:
    """Appends one JSON line per completed RL step, then raises StopTraining if the policy says so."""
    history: list[dict[str, Any]] = []

    def hook(step: StepInfo) -> None:
        summary = telemetry.drain()
        history.append(summary)
        spent = ledger.spent if ledger is not None else 0.0
        reason = policy.reason(history, spent)
        row = {
            "at": datetime.now(UTC).isoformat(),
            "run": run,
            "n": step.n,
            "model_step": step.model_step,
            **summary,
            "tokens": step.usage,
            "step_cost_usd": step.cost_usd,
            "spent_usd": spent,
            "river": {k: v for k, v in step.river_metrics.items() if isinstance(v, int | float | str | bool) or v is None},
            "stop_reason": reason,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, default=str) + "\n")
        if reason is not None:
            raise StopTraining(reason)

    return hook


def _recording(reward_fn: RewardFn, sink: list[float]) -> RewardFn:
    def wrapped(row: RlRow, completion: str) -> float:
        value = reward_fn(row, completion)
        sink.append(value)
        return value

    return wrapped


def _per_step(rewards: list[float], per_step: int) -> list[float]:
    return [sum(rewards[i : i + per_step]) / per_step for i in range(0, len(rewards), per_step)]


def evaluate(
    backend: TrainerBackend, target: ModelRef, benchmark: FrozenBenchmark, scorer: DeckScorer, config: PipelineConfig
) -> EvalMetrics:
    return evaluate_decks(backend, target, benchmark, scorer, config)[0]


def evaluate_decks(
    backend: TrainerBackend, target: ModelRef, benchmark: FrozenBenchmark, scorer: DeckScorer, config: PipelineConfig
) -> tuple[EvalMetrics, list[tuple[str, ScoredDeck]]]:
    verify_frozen(benchmark)
    decks: list[ScoredDeck] = []
    labelled: list[tuple[str, ScoredDeck]] = []
    n_malformed = 0
    for episode in benchmark.episodes:
        system, user = render_reader_prompt(episode)
        texts = backend.sample(
            target,
            system=system,
            user=user,
            n=config.eval_samples_per_episode,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            seed=config.seed + 1,
        )
        for text in texts:
            try:
                parsed = parse_deck(text, model_version="eval")
            except MalformedDeckError:
                n_malformed += 1
                continue
            deck = scorer.score(episode, parsed.reads, n_invalid=len(parsed.errors))
            decks.append(deck)
            labelled.append((episode.episode_id, deck))
    if not decks:
        raise ValueError(f"every completion from {target} was malformed ({n_malformed}); nothing to evaluate")
    return compute_metrics(decks, n_malformed=n_malformed), labelled


def run_audit(
    verdicts: Sequence[VerdictRecord] | None, digests: Mapping[str, EvidenceDigest], verifier: Verifier, config: PipelineConfig
) -> AuditResult | None:
    if verdicts is None:
        if config.require_audit:
            raise VerifierDistrustedError("require_audit is set but no human verdicts were provided")
        return None
    by_digest: dict[str, list[VerdictRecord]] = {}
    for record in verdicts:
        if record.digest_id not in digests:
            raise KeyError(f"verdict for unknown digest {record.digest_id}; audit must run where that evidence lives")
        by_digest.setdefault(record.digest_id, []).append(record)
    verifier_verdicts = {}
    for digest_id, records in by_digest.items():
        judged = verifier.verify_many([r.read.text for r in records], digests[digest_id].items)
        verifier_verdicts.update({(digest_id, r.read.id): v for r, v in zip(records, judged, strict=True)})
    result = audit_verifier(verdicts, verifier_verdicts, min_overlap=config.min_audit_overlap)
    if result.status is AuditStatus.STOP:
        raise VerifierDistrustedError(
            f"verifier/human agreement {result.agreement:.3f} (Wilson 95% upper {result.upper_bound:.3f}) "
            f"< {result.threshold} on {result.overlap} reads"
        )
    if result.status is AuditStatus.INSUFFICIENT_DATA and config.require_audit:
        raise VerifierDistrustedError(f"only {result.overlap} overlapping reads, need {config.min_audit_overlap}")
    return result


def split_digests(
    digests: Sequence[EvidenceDigest], config: PipelineConfig
) -> tuple[list[EvidenceDigest], list[Episode], FrozenBenchmark, frozenset[str]]:
    unknown = config.heldout_digest_ids - {d.digest_id for d in digests}
    if unknown:
        raise ValueError(f"held-out digest ids not in the input: {sorted(unknown)}")
    training_digests: list[EvidenceDigest] = []
    benchmark_episodes: list[Episode] = []
    for digest in digests:
        if digest.digest_id in config.heldout_digest_ids:
            benchmark_episodes.extend(build_episodes(digest, config.split, config.seed))
            continue
        truncated, window = hold_out_time_window(digest, fraction=config.time_window_fraction, min_hidden=config.split.min_hidden)
        if window is None:
            raise ValueError(f"digest {digest.digest_id} has too few dated items to hold out a time window")
        training_digests.append(truncated)
        benchmark_episodes.append(window)
    if not training_digests:
        raise ValueError("every digest is held out; nothing left to train on")
    training_episodes = [e for d in training_digests for e in build_episodes(d, config.split, config.seed)]
    benchmark = freeze_benchmark(benchmark_episodes)
    assert_no_leakage(benchmark, training_episodes)
    return training_digests, training_episodes, benchmark, config.heldout_digest_ids


def run_pipeline(
    backend: TrainerBackend,
    verifier: Verifier,
    base_rates: BaseRateSource,
    digests: Sequence[EvidenceDigest],
    config: PipelineConfig,
    *,
    verdicts: Sequence[VerdictRecord] | None = None,
) -> PipelineResult:
    """Stages A and B on owner-approved digests, then the ablation on the frozen benchmark."""
    training_digests, training_episodes, benchmark, eval_ids = split_digests(digests, config)

    audit = run_audit(verdicts, {d.digest_id: d for d in digests}, verifier, config)
    critic = Critic.fit(verdicts, hashing_embedder(64), seed=config.seed) if verdicts else None
    scorer = DeckScorer(verifier, base_rates, config.reward, critic)
    eval_scorer = DeckScorer(verifier, base_rates, config.reward)
    stage_a = run_stage_a(backend, scorer, training_episodes, config)
    if not stage_a.verified_examples:
        raise StageAStarvedError(
            f"stage A kept {len(stage_a.survivors)} of {stage_a.n_teacher_reads} teacher reads but no episode had "
            f"{config.reward.deck_size} distinct survivors; sample more teacher decks per episode"
        )
    raw_ckpt = backend.start_sft(
        backend.upload_dataset("raw-teacher", stage_a.raw_examples),
        SftConfig(name="sft-raw", base_model=config.base_model, steps=config.sft_steps),
    )
    verified_ckpt = backend.start_sft(
        backend.upload_dataset("verified-teacher", stage_a.verified_examples),
        SftConfig(name="stage-a", base_model=config.base_model, steps=config.sft_steps),
    )

    by_id = {e.episode_id: e for e in training_episodes}
    rows = [RlRow(row_id=e.episode_id, system=s, user=u) for e in training_episodes for s, u in [render_reader_prompt(e)]]
    rl_base = RlConfig(
        name="",
        base_model=config.base_model,
        steps=config.rl_steps,
        group_size=config.group_size,
        groups_per_step=config.groups_per_step,
        lr=config.rl_lr,
        temperature=config.temperature,
        seed=config.seed,
    )
    history: dict[AblationRow, list[float]] = {}

    def rl(row: AblationRow, name: str, reward_fn: RewardFn, init: CheckpointRef) -> CheckpointRef:
        sink: list[float] = []
        ckpt = backend.run_rl(rows, _recording(reward_fn, sink), replace(rl_base, name=name, init_checkpoint=init))
        history[row] = _per_step(sink, config.group_size * config.groups_per_step)
        return ckpt

    grpo_ckpt = rl(AblationRow.SFT_GRPO_CORRECTNESS, "sft-grpo-correctness", correctness_reward(verifier, by_id), raw_ckpt)
    full_ckpt = rl(AblationRow.FULL, "full", information_gain_reward(scorer, by_id, config), verified_ckpt)

    targets = {
        AblationRow.BASE: ModelRef(config.base_model),
        AblationRow.SFT_RAW: ModelRef(config.base_model, raw_ckpt),
        AblationRow.SFT_GRPO_CORRECTNESS: ModelRef(config.base_model, grpo_ckpt),
        AblationRow.VERIFIED_DISTILLATION: ModelRef(config.base_model, verified_ckpt),
        AblationRow.FULL: ModelRef(config.base_model, full_ckpt),
    }
    metrics = {row: evaluate(backend, target, benchmark, eval_scorer, config) for row, target in targets.items()}
    return PipelineResult(
        table=render_ablation_table(metrics),
        metrics=metrics,
        stage_a=stage_a,
        audit=audit,
        critic_trained=critic is not None,
        reward_history=history,
        benchmark_digest_ids=eval_ids,
        training_digest_ids=frozenset(e.digest_id for e in training_episodes),
    )
