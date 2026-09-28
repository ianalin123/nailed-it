"""The first full training run, as resumable stages. Each stage reads and writes .spend/full/state.json.

freeze -> stage-a -> sft -> rl-full -> rl-correctness -> eval -> results

Every River call goes through the persistent SpendLedger (cap $50). RL stops early per StopPolicy ($45).
Artifacts that contain read text live under .spend/ only.
"""

import json
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from nailed_it_training.base_rate import CachingJudge, CategoryShrunkBaseRate, LlmBaseRateJudge
from nailed_it_training.episodes import Episode, EpisodeKind, SplitConfig, build_episodes
from nailed_it_training.eval import AblationRow, EvalMetrics, ScoredDeck, render_ablation_table
from nailed_it_training.ledger import SpendLedger
from nailed_it_training.pipeline import (
    DeckScorer,
    FrozenBenchmark,
    PipelineConfig,
    StopPolicy,
    Telemetry,
    _completion,
    assemble_decks,
    assert_no_leakage,
    correctness_reward,
    evaluate_decks,
    freeze_benchmark,
    information_gain_reward,
    metrics_hook,
    verify_frozen,
)
from nailed_it_training.protocol import EvidenceDigest, EvidenceItem, Read, ReadCategory, SourceKind
from nailed_it_training.reader import MalformedDeckError, parse_deck, render_reader_prompt
from nailed_it_training.reward import Gate, RewardConfig, ScoredRead
from nailed_it_training.river_adapter import CheckpointRef, ModelRef, RiverBackend, RlConfig, RlRow, SftConfig, SftExample
from nailed_it_training.smoke import LEDGER_PATH, SPEND_DIR, load_digest
from nailed_it_training.verifier import CachingVerifier, LlmVerifier

BASE = "Qwen/Qwen3.6-35B-A3B-FP8"
TEACHER = "Qwen/Qwen3.5-397B-A17B-FP8"
CAP_USD = 50.0
STOP_SPEND_USD = 45.0
CUTOFF = datetime(2026, 8, 15, tzinfo=UTC)
HELDOUT_SOURCE = SourceKind.GIT_HISTORY
MIN_BENCH_VISIBLE = 150
MIN_BENCH_HIDDEN = 80
PROMPT_VISIBLE = 60
TEACHER_DECKS = 8
WORKERS = 8
EVAL_SAMPLES = 4
EVAL_TEMPERATURE = 0.7
FULL_DIR = SPEND_DIR / "full"
STATE = FULL_DIR / "state.json"
BENCHMARK = SPEND_DIR / "benchmark.json"
METRICS = SPEND_DIR / "metrics.jsonl"
RL_FULL = RlConfig(
    name="nailed-full",
    base_model=BASE,
    steps=40,
    group_size=8,
    groups_per_step=4,
    lr=1e-5,
    lora_rank=16,
    max_generated_tokens=4096,
    max_context_tokens=16384,
    temperature=1.0,
    seed=0,
    checkpoint_every=10,
)
RL_CORRECTNESS_MAX_STEPS = 15
SFT_RANK = 16


class StageError(RuntimeError):
    pass


def _load_state() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def _save_state(state: dict[str, Any]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1, default=str))


def _ckpt(d: dict[str, Any]) -> CheckpointRef:
    return CheckpointRef(**d)


def _recent(items: list[EvidenceItem] | tuple[EvidenceItem, ...], k: int = PROMPT_VISIBLE) -> tuple[EvidenceItem, ...]:
    ordered = sorted(items, key=lambda i: (i.observed_at or datetime.min.replace(tzinfo=UTC), i.id))
    return tuple(ordered[-k:])


def _prompt_capped(episode: Episode) -> Episode:
    return replace(episode, visible=_recent(episode.visible))


def split(digest: EvidenceDigest) -> tuple[list[Episode], FrozenBenchmark, EvidenceDigest]:
    """Benchmark: (1) temporal, pre-cutoff non-git visible vs post-cutoff non-git hidden; (2) source holdout,
    same visible vs every git item. Training sees only non-git items before the cutoff."""
    dated = [i for i in digest.items if i.observed_at is not None]
    if len(dated) != len(digest.items):
        raise StageError("the full run expects every item to be dated")
    pre = [i for i in dated if i.source is not HELDOUT_SOURCE and i.observed_at < CUTOFF]  # type: ignore[operator]
    post = [i for i in dated if i.source is not HELDOUT_SOURCE and i.observed_at >= CUTOFF]  # type: ignore[operator]
    held = [i for i in dated if i.source is HELDOUT_SOURCE]
    if len(pre) < MIN_BENCH_VISIBLE or len(post) < MIN_BENCH_HIDDEN or len(held) < MIN_BENCH_HIDDEN:
        raise StageError(f"split too small: visible {len(pre)}, temporal hidden {len(post)}, source hidden {len(held)}")
    did, name = digest.digest_id, digest.display_name
    bench = [
        Episode(
            episode_id="bench:temporal",
            kind=EpisodeKind.TEMPORAL,
            visible=_recent(pre),
            hidden=tuple(post),
            cutoff=CUTOFF,
            digest_id=did,
            display_name=name,
        ),
        Episode(
            episode_id=f"bench:source:{HELDOUT_SOURCE.value}",
            kind=EpisodeKind.LEAVE_ONE_SOURCE_OUT,
            visible=_recent(pre),
            hidden=tuple(held),
            held_out_source=HELDOUT_SOURCE,
            digest_id=did,
            display_name=name,
        ),
    ]
    training_digest = digest.model_copy(update={"items": pre})
    training = [_prompt_capped(e) for e in build_episodes(training_digest, SplitConfig(n_temporal=8, min_visible=30, min_hidden=15), seed=0)]
    benchmark = freeze_benchmark(bench)
    assert_no_leakage(benchmark, training)
    bench_hidden = {i.id for e in bench for i in e.hidden}
    if bench_hidden & {i.id for i in pre}:
        raise StageError("benchmark hidden items overlap the training items")
    return training, benchmark, training_digest


def _episodes_from_state(state: dict[str, Any], digest: EvidenceDigest) -> tuple[list[Episode], FrozenBenchmark]:
    training, benchmark, _ = split(digest)
    if benchmark.fingerprint != state["benchmark_fingerprint"]:
        raise StageError("benchmark changed since it was frozen")
    verify_frozen(benchmark)
    if [e.episode_id for e in training] != state["training_episode_ids"]:
        raise StageError("training episodes changed since freeze")
    return training, benchmark


def stage_freeze() -> dict[str, Any]:
    digest, kind = load_digest()
    if kind != "real":
        raise StageError("the full run needs the real digest")
    training, benchmark, training_digest = split(digest)
    definition = {
        "frozen_at": datetime.now(UTC).isoformat(),
        "digest_id": digest.digest_id,
        "cutoff": CUTOFF.isoformat(),
        "heldout_source": HELDOUT_SOURCE.value,
        "prompt_visible_cap": PROMPT_VISIBLE,
        "fingerprint": benchmark.fingerprint,
        "episodes": [
            {"id": e.episode_id, "kind": e.kind.value, "visible_ids": [i.id for i in e.visible], "hidden_ids": [i.id for i in e.hidden]}
            for e in benchmark.episodes
        ],
        "training_item_ids": [i.id for i in training_digest.items],
        "training_episodes": [
            {"id": e.episode_id, "visible_ids": [i.id for i in e.visible], "hidden_ids": [i.id for i in e.hidden]} for e in training
        ],
    }
    BENCHMARK.parent.mkdir(parents=True, exist_ok=True)
    BENCHMARK.write_text(json.dumps(definition, indent=1))
    state = {"benchmark_fingerprint": benchmark.fingerprint, "training_episode_ids": [e.episode_id for e in training]}
    _save_state(state)
    return {
        "benchmark_episodes": [(e.episode_id, len(e.visible), len(e.hidden)) for e in benchmark.episodes],
        "training_items": len(training_digest.items),
        "training_episodes": [(e.episode_id.split(":", 1)[1], len(e.visible), len(e.hidden)) for e in training],
    }


class Rig:
    """Backend, ledger, verifier, judge and scorer shared by the stages of one process."""

    def __init__(self, category_means: dict[str, float] | None = None, telemetry: Telemetry | None = None) -> None:
        self.ledger = SpendLedger(cap_usd=CAP_USD, path=LEDGER_PATH)
        self.backend = RiverBackend.from_env(self.ledger, thinking=False, step_log=FULL_DIR / "river_steps.jsonl")
        self.inner_verifier = LlmVerifier(
            self.backend.llm_client(BASE, max_tokens=3072, label="full:verifier"), batch_size=12, on_ungrounded="reject"
        )
        self.verifier = CachingVerifier(self.inner_verifier)
        self.judge = CachingJudge(LlmBaseRateJudge(self.backend.llm_client(BASE, max_tokens=1536, label="full:judge")))
        means = {ReadCategory(k): v for k, v in category_means.items()} if category_means else None
        self.base_rates = CategoryShrunkBaseRate(self.judge, category_means=means)
        self.scorer = DeckScorer(self.verifier, self.base_rates, RewardConfig())


def _parse(text: str, model: str) -> tuple[list[Read], int] | None:
    try:
        parsed = parse_deck(text, model_version=model)
    except MalformedDeckError:
        return None
    return parsed.reads, len(parsed.errors)


def stage_a() -> dict[str, Any]:
    state = _load_state()
    digest, _ = load_digest()
    training, _ = _episodes_from_state(state, digest)
    rig = Rig()
    samples_path = FULL_DIR / "teacher_samples.json"
    if samples_path.exists():
        samples: dict[str, list[str]] = json.loads(samples_path.read_text())
        if sorted(samples) != sorted(e.episode_id for e in training):
            raise StageError("saved teacher samples do not match the frozen training episodes")
    else:
        samples = {}
        for episode in training:
            system, user = render_reader_prompt(episode)
            samples[episode.episode_id] = rig.backend.sample(
                ModelRef(TEACHER), system=system, user=user, n=TEACHER_DECKS, max_tokens=4096, temperature=1.0, seed=0
            )
        samples_path.write_text(json.dumps(samples))
    parsed = {eid: [p for t in texts if (p := _parse(t, TEACHER)) is not None] for eid, texts in samples.items()}
    all_reads = [r for decks in parsed.values() for reads, _ in decks for r in reads]
    chunks = [all_reads[i : i + 12] for i in range(0, len(all_reads), 12)]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(lambda c: rig.judge.judge_many([(r.text, r.category) for r in c]), chunks))
    means = CategoryShrunkBaseRate.fit_category_means(rig.judge, all_reads)
    rig.base_rates = CategoryShrunkBaseRate(rig.judge, category_means=means)
    rig.scorer = DeckScorer(rig.verifier, rig.base_rates, RewardConfig())
    by_id = {e.episode_id: e for e in training}

    def score_episode(eid: str) -> tuple[str, list[SftExample], list[ScoredRead]]:
        system, user = render_reader_prompt(by_id[eid])
        raw_here: list[SftExample] = []
        pooled: list[ScoredRead] = []
        for text in samples[eid]:
            p = _parse(text, TEACHER)
            if p is None or not p[0]:
                continue
            raw_here.append(SftExample(system, user, text))
            deck = rig.scorer.score(by_id[eid], p[0], n_invalid=p[1])
            pooled.extend(s for s in deck.reads if s.gate is Gate.PASSED and s.outcome is not None and s.reward > 0)
        return eid, raw_here, pooled

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        scored = list(pool.map(score_episode, sorted(samples)))
    raw: list[SftExample] = []
    verified: list[SftExample] = []
    survivors: list[ScoredRead] = []
    skipped = 0
    for eid, raw_here, pooled in scored:
        system, user = render_reader_prompt(by_id[eid])
        raw.extend(raw_here)
        survivors.extend(pooled)
        decks = assemble_decks(pooled)
        skipped += not decks
        verified.extend(SftExample(system, user, _completion(d)) for d in decks)
    (FULL_DIR / "stage_a_examples.json").write_text(json.dumps({"raw": [asdict(x) for x in raw], "verified": [asdict(x) for x in verified]}))
    state.update(
        category_means={k.value: v for k, v in means.items()},
        stage_a={
            "teacher_decks": sum(len(v) for v in samples.values()),
            "parsed_decks": sum(len(v) for v in parsed.values()),
            "teacher_reads": len(all_reads),
            "survivors": len(survivors),
            "raw_examples": len(raw),
            "verified_examples": len(verified),
            "skipped_episodes": skipped,
            "verifier": vars(rig.inner_verifier.stats),
        },
    )
    _save_state(state)
    return {**state["stage_a"], "spent": rig.ledger.spent}


def _examples(kind: str) -> list[SftExample]:
    data = json.loads((FULL_DIR / "stage_a_examples.json").read_text())
    return [SftExample(**x) for x in data[kind]]


def stage_sft() -> dict[str, Any]:
    state = _load_state()
    rig = Rig(state["category_means"])
    verified = _examples("verified")
    if not verified:
        raise StageError("stage A produced no 12-read decks; cannot build the verified SFT set")
    out: dict[str, Any] = {}
    for key, name, examples, steps in (
        ("sft_raw", "nailed-sft-raw", _examples("raw"), 12),
        ("sft_verified", "nailed-stage-a", verified, max(4, min(12, math.ceil(2 * len(verified) / 8)))),
    ):
        if key in state:
            out[key] = state[key]
            continue
        handle = rig.backend.upload_dataset(name, examples)
        ckpt = rig.backend.start_sft(handle, SftConfig(name=name, base_model=BASE, steps=steps, batch_size=8, lr=1e-4, lora_rank=SFT_RANK))
        state[key] = {**asdict(ckpt), "steps": steps, "examples": len(examples)}
        _save_state(state)
        out[key] = state[key]
    return {**out, "spent": rig.ledger.spent}


def _rows(training: list[Episode]) -> list[RlRow]:
    return [RlRow(e.episode_id, s, u) for e in training for s, u in [render_reader_prompt(e)]]


def _run_rl(key: str, config: RlConfig, reward_kind: str, init_key: str) -> dict[str, Any]:
    state = _load_state()
    if key in state:
        return state[key]
    digest, _ = load_digest()
    training, _ = _episodes_from_state(state, digest)
    telemetry = Telemetry(capture=FULL_DIR / f"{key}_failures.jsonl")
    rig = Rig(state["category_means"])
    by_id = {e.episode_id: e for e in training}
    reward = (
        information_gain_reward(rig.scorer, by_id, PipelineConfig(), telemetry=telemetry)
        if reward_kind == "information_gain"
        else correctness_reward(rig.verifier, by_id, telemetry=telemetry)
    )
    spent_before = rig.ledger.spent
    hook = metrics_hook(config.name, telemetry, METRICS, StopPolicy(spend_limit=STOP_SPEND_USD), rig.ledger)
    config = replace(
        config, init_checkpoint=_ckpt({k: v for k, v in state[init_key].items() if k in ("training_path", "inference_path", "base_model")})
    )
    try:
        ckpt = rig.backend.run_rl(_rows(training), reward, config, on_step=hook)
    except Exception:
        crashed = _load_state()
        crashed[f"{key}_crash"] = {
            "stop_reason": rig.backend.stop_reason,
            "error_checkpoint": asdict(rig.backend.error_checkpoint) if rig.backend.error_checkpoint else None,
            "periodic": [asdict(c) for c in rig.backend.periodic_checkpoints],
            "steps_done": len(rig.backend.last_rl_steps),
        }
        _save_state(crashed)
        raise
    steps_done = len([s for s in rig.backend.last_rl_steps])
    state = _load_state()
    state[key] = {
        **asdict(ckpt),
        "periodic": [asdict(c) for c in rig.backend.periodic_checkpoints],
        "stop_reason": rig.backend.stop_reason,
        "steps_done": steps_done,
        "spent_usd": rig.ledger.spent - spent_before,
        "verifier": vars(rig.inner_verifier.stats),
    }
    _save_state(state)
    return state[key]


def stage_rl_full() -> dict[str, Any]:
    return _run_rl("rl_full", RL_FULL, "information_gain", "sft_verified")


def stage_rl_correctness() -> dict[str, Any]:
    state = _load_state()
    if "rl_correctness" in state:
        return state["rl_correctness"]
    full = state["rl_full"]
    per_step = full["spent_usd"] / max(1, full["steps_done"])
    ledger = SpendLedger(cap_usd=CAP_USD, path=LEDGER_PATH)
    eval_reserve = 2.5
    affordable = math.floor((STOP_SPEND_USD - ledger.spent - eval_reserve) / (0.75 * per_step)) if per_step > 0 else 0
    steps = min(RL_CORRECTNESS_MAX_STEPS, affordable)
    if steps < 5:
        state["rl_correctness"] = {"skipped": True, "reason": f"budget allows {steps} steps at ${per_step:.2f}/step"}
        _save_state(state)
        return state["rl_correctness"]
    config = replace(RL_FULL, name="nailed-grpo-correctness", steps=steps, checkpoint_every=None)
    return _run_rl("rl_correctness", config, "correctness", "sft_raw")


ROW_KEYS = {
    AblationRow.BASE: None,
    AblationRow.SFT_RAW: "sft_raw",
    AblationRow.SFT_GRPO_CORRECTNESS: "rl_correctness",
    AblationRow.VERIFIED_DISTILLATION: "sft_verified",
    AblationRow.FULL: "rl_full",
}


def _deck_json(episode_id: str, deck: ScoredDeck) -> dict[str, Any]:
    return {
        "episode": episode_id,
        "deck_reward": deck.reward.total,
        "n_invalid": deck.n_invalid,
        "reads": [
            {
                "text": s.read.text,
                "category": s.read.category.value,
                "confidence": s.read.confidence,
                "gate": s.gate.value,
                "outcome": s.outcome,
                "base_rate": s.base_rate,
                "reward": s.reward,
                "verdict": s.verdict.label.value if s.verdict else None,
            }
            for s in deck.reads
        ],
    }


def stage_eval() -> dict[str, Any]:
    state = _load_state()
    digest, _ = load_digest()
    _, benchmark = _episodes_from_state(state, digest)
    rig = Rig(state["category_means"])
    config = PipelineConfig(eval_samples_per_episode=EVAL_SAMPLES, temperature=EVAL_TEMPERATURE, max_tokens=4096, seed=0)
    results: dict[str, Any] = state.get("eval", {})
    for row, key in ROW_KEYS.items():
        if row.name in results:
            continue
        if key is not None and (key not in state or state[key].get("skipped")):
            results[row.name] = {"skipped": True}
            continue
        target = (
            ModelRef(BASE) if key is None else ModelRef(BASE, _ckpt({k: state[key][k] for k in ("training_path", "inference_path", "base_model")}))
        )
        metrics, decks = evaluate_decks(rig.backend, target, benchmark, rig.scorer, config)
        (FULL_DIR / f"eval_decks_{row.name}.json").write_text(json.dumps([_deck_json(e, d) for e, d in decks]))
        results[row.name] = asdict(metrics)
        state["eval"] = results
        _save_state(state)
    return {"eval": results, "spent": rig.ledger.spent}


NATS_PER_BIT = math.log(2)


def _pairs() -> list[dict[str, Any]]:
    """Fixed rule: for each benchmark episode take sample 0 of the base model and of the full reader; pair their
    highest-reward valid reads, and for the temporal episode also their median-reward reads."""
    base = json.loads((FULL_DIR / "eval_decks_BASE.json").read_text())
    full = json.loads((FULL_DIR / "eval_decks_FULL.json").read_text())
    pairs = []
    for episode in dict.fromkeys(d["episode"] for d in base):
        b = sorted(next(d for d in base if d["episode"] == episode)["reads"], key=lambda r: -r["reward"])
        f = sorted(next(d for d in full if d["episode"] == episode)["reads"], key=lambda r: -r["reward"])
        picks = [("best", 0, 0)]
        if episode == "bench:temporal":
            picks.append(("median", len(b) // 2, len(f) // 2))
        for rule, bi, fi in picks:
            pairs.append({"episode": episode, "rule": rule, "base": b[bi], "trained": f[fi]})
    return pairs


def stage_results() -> dict[str, Any]:
    state = _load_state()
    ledger = SpendLedger(cap_usd=CAP_USD, path=LEDGER_PATH)
    measured = {row: EvalMetrics(**state["eval"][row.name]) for row in AblationRow if not state["eval"].get(row.name, {}).get("skipped")}
    table = render_ablation_table(measured) if len(measured) == len(AblationRow) else _partial_table(measured)
    (FULL_DIR / "ablation.md").write_text(table)
    pairs = _pairs() if all(r in measured for r in (AblationRow.BASE, AblationRow.FULL)) else []
    checkpoints = {
        k: {"inference": state[k]["inference_path"], "training": state[k]["training_path"]}
        for k in ROW_KEYS.values()
        if k and k in state and not state[k].get("skipped")
    }
    periodic = [c["inference_path"] for c in state.get("rl_full", {}).get("periodic", [])]
    private = {
        "generated_at": datetime.now(UTC).isoformat(),
        "units": {"information_gain": "nats per read in metrics; bits in the demo file"},
        "ablation": {row.name: state["eval"].get(row.name) for row in AblationRow},
        "stage_a": state.get("stage_a"),
        "rl": {k: {kk: vv for kk, vv in state[k].items() if kk not in ("periodic",)} for k in ("rl_full", "rl_correctness") if k in state},
        "checkpoints": checkpoints,
        "periodic_checkpoints": periodic,
        "pairs": pairs,
        "spend": ledger.totals(),
    }
    (SPEND_DIR / "results.json").write_text(json.dumps(private, indent=1, default=str))
    _write_demo(pairs, measured)
    return {"table": table, "checkpoints": checkpoints, "periodic": periodic, "spend": ledger.totals(), "n_pairs": len(pairs)}


def _partial_table(measured: dict[AblationRow, EvalMetrics]) -> str:
    lines = [
        "| Row | Verified acc | Info gain / read | ECE | Restatement | Unverifiable | Ungrounded | Redundancy | Reads |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for row in AblationRow:
        m = measured.get(row)
        if m is None:
            lines.append(f"| {row.label} | skipped | | | | | | | |")
            continue
        vals = [
            m.verified_accuracy,
            m.mean_information_gain,
            m.expected_calibration_error,
            m.restatement_rate,
            m.unverifiable_rate,
            m.ungrounded_rate,
            m.deck_redundancy,
        ]
        lines.append(f"| {row.label} | " + " | ".join("n/a" if v is None else f"{v:.3f}" for v in vals) + f" | {m.n_reads} |")
    return "\n".join(lines) + "\n"


def _write_demo(pairs: list[dict[str, Any]], measured: dict[AblationRow, EvalMetrics]) -> None:
    """Numbers only. Read text about the real person never enters the demo folder, so read fields are null."""
    demo = Path(__file__).resolve().parents[3] / "demo" / "data" / "results.json"
    best = next((p for p in pairs if p["episode"] == "bench:temporal" and p["rule"] == "best"), None)
    temporal = json.loads(BENCHMARK.read_text())["episodes"][0]

    def side(label: str, read: dict[str, Any] | None) -> dict[str, Any]:
        return {"label": label, "read": None, "infoGain": None if read is None else read["reward"] / NATS_PER_BIT}

    payload = {
        "horoscopeTest": {
            "evidenceNote": f"{len(temporal['visible_ids'])} visible items before the cutoff; {len(temporal['hidden_ids'])} later items held out",
            "unit": "bits",
            "base": side(f"{BASE} (base)", best["base"] if best else None),
            "trained": side("Nailed It reader (stage A + RL)", best["trained"] if best else None),
        },
        "learning": {
            "trainingSet": {"before": None, "after": None},
            "procedure": {"title": None, "steps": None},
            "recall": {"nextPlayer": None, "stepsWithout": None, "stepsWith": None},
        },
    }
    demo.write_text(json.dumps(payload, indent=2) + "\n")


STAGES = {
    "freeze": stage_freeze,
    "stage-a": stage_a,
    "sft": stage_sft,
    "rl-full": stage_rl_full,
    "rl-correctness": stage_rl_correctness,
    "eval": stage_eval,
    "results": stage_results,
}
