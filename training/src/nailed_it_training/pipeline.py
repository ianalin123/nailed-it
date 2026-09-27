"""Stages A and B end to end, plus the frozen benchmark and the five-row ablation."""

import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace

from nailed_it_training.base_rate import BaseRateSource
from nailed_it_training.critic import AUDIT_MIN_OVERLAP, AuditResult, AuditStatus, Critic, audit_verifier, hashing_embedder
from nailed_it_training.episodes import Episode, EpisodeKind, SplitConfig, build_episodes
from nailed_it_training.eval import AblationRow, EvalMetrics, ScoredDeck, compute_metrics, render_ablation_table
from nailed_it_training.fake_backend import FAKE_BASE, FAKE_TEACHER
from nailed_it_training.protocol import EvidenceDigest, Read, VerdictRecord
from nailed_it_training.reader import MalformedDeckError, parse_reads, render_reader_prompt
from nailed_it_training.reward import Gate, RewardConfig, ScoredRead, deck_reward, score_read
from nailed_it_training.river_adapter import CheckpointRef, ModelRef, RlConfig, RlRow, SftConfig, SftExample, TrainerBackend
from nailed_it_training.verifier import VerdictLabel, Verifier, is_restatement


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
    min_survivors: int = 3
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
    """Scores a deck with batched verifier calls: one pass over hidden items, one over visible items for restatement."""

    def __init__(self, verifier: Verifier, base_rates: BaseRateSource, config: RewardConfig, critic: Critic | None = None) -> None:
        self._verifier = verifier
        self._base_rates = base_rates
        self._config = config
        self._critic = critic

    def score(self, episode: Episode, reads: Sequence[Read]) -> ScoredDeck:
        texts = [r.text for r in reads]
        verdicts = self._verifier.verify_many(texts, episode.hidden)
        entailed = [is_restatement(v, self._config.min_verdict_strength) for v in self._verifier.verify_many(texts, episode.visible)]
        rates = self._base_rates.base_rates(reads, episode.digest_id)
        scored = tuple(
            score_read(
                read,
                visible_ids=episode.visible_ids,
                verdict=verdict,
                base_rate=rate,
                config=self._config,
                entailed_by_visible=ent,
                critic=self._critic.predict(read) if self._critic else None,
            )
            for read, verdict, rate, ent in zip(reads, verdicts, rates, entailed, strict=True)
        )
        return ScoredDeck(reads=scored, reward=deck_reward(reads, [s.reward for s in scored], self._config))


def _completion(reads: Sequence[Read]) -> str:
    return json.dumps({"reads": [r.model_dump(by_alias=True, exclude={"model_version"}) for r in reads]})


def run_stage_a(
    backend: TrainerBackend, scorer: DeckScorer, episodes: Sequence[Episode], config: PipelineConfig
) -> StageAResult:
    """Teacher writes decks; keep reads that pass the gates and verify with R > 0."""
    raw: list[SftExample] = []
    verified: list[SftExample] = []
    survivors: list[ScoredRead] = []
    n_reads = n_malformed = 0
    for episode in episodes:
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
                reads = parse_reads(text, model_version=config.teacher_model)
            except MalformedDeckError:
                n_malformed += 1
                continue
            n_reads += len(reads)
            raw.append(SftExample(system=system, user=user, completion=text))
            kept = [s for s in scorer.score(episode, reads).reads if s.gate is Gate.PASSED and s.outcome is not None and s.reward > 0]
            survivors.extend(kept)
            if len(kept) >= config.min_survivors:
                verified.append(SftExample(system=system, user=user, completion=_completion([s.read for s in kept])))
    return StageAResult(tuple(raw), tuple(verified), tuple(survivors), n_reads, n_malformed)


RewardFn = Callable[[RlRow, str], float]


def information_gain_reward(scorer: DeckScorer, episodes: Mapping[str, Episode], config: PipelineConfig) -> RewardFn:
    def reward(row: RlRow, completion: str) -> float:
        try:
            reads = parse_reads(completion, model_version="policy")
        except MalformedDeckError:
            return config.malformed_reward
        return scorer.score(episodes[row.row_id], reads).reward.total

    return reward


def correctness_reward(verifier: Verifier, episodes: Mapping[str, Episode]) -> RewardFn:
    """The naive baseline: fraction of reads the verifier supports. No gates, no base rate."""

    def reward(row: RlRow, completion: str) -> float:
        try:
            reads = parse_reads(completion, model_version="policy")
        except MalformedDeckError:
            return 0.0
        verdicts = verifier.verify_many([r.text for r in reads], episodes[row.row_id].hidden)
        return sum(v.label is VerdictLabel.SUPPORTED for v in verdicts) / len(reads)

    return reward


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
    verify_frozen(benchmark)
    decks: list[ScoredDeck] = []
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
                decks.append(scorer.score(episode, parse_reads(text, model_version="eval")))
            except MalformedDeckError:
                n_malformed += 1
    return compute_metrics(decks, n_malformed=n_malformed)


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


def _split_digests(
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
    training_digests, training_episodes, benchmark, eval_ids = _split_digests(digests, config)

    audit = run_audit(verdicts, {d.digest_id: d for d in digests}, verifier, config)
    critic = Critic.fit(verdicts, hashing_embedder(64), seed=config.seed) if verdicts else None
    scorer = DeckScorer(verifier, base_rates, config.reward, critic)
    eval_scorer = DeckScorer(verifier, base_rates, config.reward)
    stage_a = run_stage_a(backend, scorer, training_episodes, config)
    if not stage_a.verified_examples:
        raise StageAStarvedError(
            f"stage A kept {len(stage_a.survivors)} of {stage_a.n_teacher_reads} teacher reads but no deck had "
            f"{config.min_survivors}+ survivors; sample more teacher decks or lower min_survivors"
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
