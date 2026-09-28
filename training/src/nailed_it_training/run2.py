"""Run 2: RL from the base model with the distance-weighted reward, relative stop rules, a checkpoint curve, and
eval with uncertainty. Stages: rl -> eval -> rl-correctness -> eval-correctness -> results.

State lives in .spend/run2/state.json. Read text about the real person stays under .spend/.
"""

import json
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from datetime import UTC, datetime
from typing import Any

from nailed_it_training.eval import (
    ScoredDeck,
    compute_metrics,
    distinguishable,
)
from nailed_it_training.full_run import (
    BASE,
    CAP_USD,
    FULL_DIR,
    RL_FULL,
    STOP_SPEND_USD,
    Rig,
    StageError,
    _deck_json,
    run2_training_episodes,
    split,
    verify_frozen,
)
from nailed_it_training.ledger import SpendLedger
from nailed_it_training.pipeline import (
    FrozenBenchmark,
    PipelineConfig,
    StopPolicy,
    Telemetry,
    correctness_reward,
    information_gain_reward,
    metrics_hook,
)
from nailed_it_training.reader import MalformedDeckError, parse_deck, render_reader_prompt
from nailed_it_training.river_adapter import CheckpointRef, ModelRef, RlRow
from nailed_it_training.smoke import LEDGER_PATH, SPEND_DIR, load_digest

RUN2_DIR = SPEND_DIR / "run2"
STATE = RUN2_DIR / "state.json"
METRICS = RUN2_DIR / "metrics.jsonl"
EVAL_DECKS_PER_EPISODE = 10
EVAL_TEMPERATURE = 0.7
WORKERS = 8
RL_RUN2 = replace(RL_FULL, name="nailed-run2", init_checkpoint=None, checkpoint_every=10)
CORRECTNESS_STEPS = 20
EVAL_RESERVE_USD = 2.0


def _load() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def _save(state: dict[str, Any]) -> None:
    RUN2_DIR.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1, default=str))


def _category_means() -> dict[str, float]:
    run1 = json.loads((FULL_DIR / "state.json").read_text())
    return dict(run1["category_means"])


def _setup() -> tuple[Any, FrozenBenchmark]:
    digest, kind = load_digest()
    if kind != "real":
        raise StageError("run 2 needs the real digest")
    training = run2_training_episodes(digest)
    _, benchmark, _ = split(digest)
    frozen = json.loads((SPEND_DIR / "benchmark.json").read_text())
    if benchmark.fingerprint != frozen["fingerprint"]:
        raise StageError("benchmark differs from the frozen definition")
    verify_frozen(benchmark)
    bench_hidden = {i.id for e in benchmark.episodes for i in e.hidden}
    for e in training:
        if bench_hidden & {i.id for i in (*e.visible, *e.hidden)}:
            raise StageError(f"training episode {e.episode_id} touches benchmark hidden items")
    return training, benchmark


def _rows(training: list[Any]) -> list[RlRow]:
    return [RlRow(e.episode_id, s, u) for e in training for s, u in [render_reader_prompt(e)]]


def _run(key: str, reward_kind: str, steps: int, checkpoint_every: int | None) -> dict[str, Any]:
    state = _load()
    if key in state:
        return state[key]
    training, _ = _setup()
    rig = Rig(_category_means())
    telemetry = Telemetry(capture=RUN2_DIR / f"{key}_failures.jsonl")
    by_id = {e.episode_id: e for e in training}
    reward = (
        information_gain_reward(rig.scorer, by_id, PipelineConfig(), telemetry=telemetry)
        if reward_kind == "information_gain"
        else correctness_reward(rig.verifier, by_id, telemetry=telemetry)
    )
    config = replace(RL_RUN2, name=f"nailed-run2-{key}", steps=steps, checkpoint_every=checkpoint_every)
    hook = metrics_hook(config.name, telemetry, METRICS, StopPolicy(spend_limit=STOP_SPEND_USD), rig.ledger)
    spent_before = rig.ledger.spent
    started = datetime.now(UTC)
    try:
        ckpt = rig.backend.run_rl(_rows(training), reward, config, on_step=hook)
    except Exception:
        crashed = _load()
        crashed[f"{key}_crash"] = {
            "stop_reason": rig.backend.stop_reason,
            "error_checkpoint": asdict(rig.backend.error_checkpoint) if rig.backend.error_checkpoint else None,
            "periodic": [asdict(c) for c in rig.backend.periodic_checkpoints],
        }
        _save(crashed)
        raise
    state = _load()
    state[key] = {
        **asdict(ckpt),
        "periodic": [asdict(c) for c in rig.backend.periodic_checkpoints],
        "stop_reason": rig.backend.stop_reason,
        "steps_done": len(rig.backend.last_rl_steps),
        "spent_usd": rig.ledger.spent - spent_before,
        "minutes": (datetime.now(UTC) - started).total_seconds() / 60,
        "training_episodes": len(training),
        "verifier": vars(rig.inner_verifier.stats),
    }
    _save(state)
    return state[key]


def stage_rl() -> dict[str, Any]:
    return _run("rl", "information_gain", RL_RUN2.steps, 10)


def _ref(d: dict[str, Any]) -> CheckpointRef:
    return CheckpointRef(training_path=d["training_path"], inference_path=d["inference_path"], base_model=d["base_model"])


def _eval_target(rig: Rig, name: str, target: ModelRef, benchmark: FrozenBenchmark) -> dict[str, Any]:
    RUN2_DIR.mkdir(parents=True, exist_ok=True)
    samples_path = RUN2_DIR / f"eval_samples_{name}.json"
    if samples_path.exists():
        samples: dict[str, list[str]] = json.loads(samples_path.read_text())
    else:
        samples = {}
        for episode in benchmark.episodes:
            system, user = render_reader_prompt(episode)
            samples[episode.episode_id] = rig.backend.sample(
                target, system=system, user=user, n=EVAL_DECKS_PER_EPISODE, max_tokens=4096, temperature=EVAL_TEMPERATURE, seed=1
            )
        samples_path.write_text(json.dumps(samples))
    decks: list[tuple[str, ScoredDeck]] = []
    malformed = 0
    jobs = []
    for episode in benchmark.episodes:
        for text in samples[episode.episode_id]:
            try:
                parsed = parse_deck(text, model_version=name)
            except MalformedDeckError:
                malformed += 1
                continue
            jobs.append((episode, parsed))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        scored = list(pool.map(lambda j: (j[0].episode_id, rig.scorer.score(j[0], j[1].reads, n_invalid=len(j[1].errors))), jobs))
    decks.extend(scored)
    if not decks:
        raise StageError(f"{name}: every completion was malformed")
    metrics = compute_metrics([d for _, d in decks], n_malformed=malformed)
    (RUN2_DIR / f"eval_decks_{name}.json").write_text(json.dumps([_deck_json(e, d) for e, d in decks]))
    return asdict(metrics)


def _eval(targets: dict[str, ModelRef]) -> dict[str, Any]:
    RUN2_DIR.mkdir(parents=True, exist_ok=True)
    state = _load()
    _, benchmark = _setup()
    rig = Rig(_category_means())
    results: dict[str, Any] = state.get("eval", {})
    todo = {k: v for k, v in targets.items() if k not in results}
    with ThreadPoolExecutor(max_workers=len(todo) or 1) as pool:
        futures = {k: pool.submit(_eval_target, rig, k, t, benchmark) for k, t in todo.items()}
        for k, f in futures.items():
            results[k] = f.result()
            state = _load()
            state["eval"] = {**state.get("eval", {}), k: results[k]}
            _save(state)
    return {"eval": {k: _summary(v) for k, v in results.items()}, "spent": rig.ledger.spent}


def stage_eval_base() -> dict[str, Any]:
    return _eval({"base": ModelRef(BASE)})


def stage_eval() -> dict[str, Any]:
    state = _load()
    rl = state["rl"]
    targets = {"base": ModelRef(BASE)}
    for c in rl["periodic"]:
        step = c["training_path"].rsplit("-step", 1)[1].split("-", 1)[0]
        targets[f"run2_step{step}"] = ModelRef(BASE, _ref(c))
    last_periodic = rl["periodic"][-1]["training_path"].rsplit("-step", 1)[1][:3] if rl["periodic"] else None
    if last_periodic is None or int(last_periodic) != rl["steps_done"]:
        targets[f"run2_final_step{rl['steps_done']:03d}"] = ModelRef(BASE, _ref(rl))
    return _eval(targets)


def stage_rl_correctness() -> dict[str, Any]:
    state = _load()
    if "rl_correctness" in state:
        return state["rl_correctness"]
    rl = state["rl"]
    per_step = rl["spent_usd"] / max(1, rl["steps_done"])
    ledger = SpendLedger(cap_usd=CAP_USD, path=LEDGER_PATH)
    affordable = math.floor((STOP_SPEND_USD - ledger.spent - EVAL_RESERVE_USD) / (0.8 * per_step)) if per_step > 0 else 0
    steps = min(CORRECTNESS_STEPS, affordable)
    if steps < 10:
        state["rl_correctness"] = {"skipped": True, "reason": f"budget allows {steps} steps at about ${0.8 * per_step:.2f}/step"}
        _save(state)
        return state["rl_correctness"]
    return _run("rl_correctness", "correctness", steps, None)


def stage_eval_correctness() -> dict[str, Any]:
    state = _load()
    rc = state.get("rl_correctness", {})
    if rc.get("skipped"):
        return {"skipped": rc["reason"]}
    return _eval({"correctness": ModelRef(BASE, _ref(rc))})


def _summary(m: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "n_reads",
        "n_decided",
        "verified_accuracy",
        "mean_information_gain",
        "ig_ci_low",
        "ig_ci_high",
        "expected_calibration_error",
        "restatement_rate",
        "unverifiable_rate",
        "ungrounded_rate",
        "mean_distance_weight",
        "deck_redundancy",
        "n_malformed",
        "n_invalid_reads",
    )
    return {k: m.get(k) for k in keys}


def _compare(a: dict[str, Any], b: dict[str, Any]) -> str:
    ia, ib = (a["ig_ci_low"], a["ig_ci_high"]), (b["ig_ci_low"], b["ig_ci_high"])
    if not distinguishable(ia, ib):
        return "not distinguishable"
    return "higher" if a["mean_information_gain"] > b["mean_information_gain"] else "lower"


def _deck_extras(name: str) -> dict[str, Any]:
    """Accuracy with a Wilson interval, share of reads supported and mean judged base rate with bootstrap intervals."""
    from nailed_it_training.critic import wilson_upper
    from nailed_it_training.eval import bootstrap_ci

    decks = json.loads((RUN2_DIR / f"eval_decks_{name}.json").read_text())
    reads = [r for d in decks for r in d["reads"]]
    decided = [r for r in reads if r["outcome"] is not None]
    acc = sum(r["outcome"] for r in decided) / len(decided)
    supported = [1.0 if r["outcome"] == 1 else 0.0 for r in reads]
    base_rates = [r["base_rate"] for r in reads if r["base_rate"] is not None]
    return {
        "accuracy_wilson95": [1 - wilson_upper(1 - acc, len(decided)), wilson_upper(acc, len(decided))],
        "supported_share": sum(supported) / len(supported),
        "supported_share_ci": list(bootstrap_ci(supported)),
        "mean_base_rate": sum(base_rates) / len(base_rates),
        "mean_base_rate_ci": list(bootstrap_ci(base_rates)),
    }


def _phase_curves(rows: list[dict[str, Any]], period: int) -> dict[str, Any]:
    """Training episodes rotate through batches with this period, so compare steps within the same phase."""
    out: dict[str, Any] = {}
    for run in sorted({r["run"] for r in rows}):
        key = "mean_reward" if "correctness" in run else "mean_information_gain"
        out[run] = {
            "metric": key,
            "phases": {str(ph): [(r["n"], r.get(key)) for r in rows if r["run"] == run and r["n"] % period == ph] for ph in range(period)},
        }
    return out


def stage_results() -> dict[str, Any]:
    state = _load()
    ledger = SpendLedger(cap_usd=CAP_USD, path=LEDGER_PATH)
    evals = {k: _summary(v) for k, v in state.get("eval", {}).items()}
    base = evals.get("base")
    comparisons = {k: _compare(v, base) for k, v in evals.items() if base and k != "base"}
    extras = {k: _deck_extras(k) for k in evals}
    curve = [json.loads(line) for line in METRICS.read_text().splitlines()] if METRICS.exists() else []
    steps = [
        {
            k: r.get(k)
            for k in (
                "run",
                "n",
                "mean_reward",
                "mean_information_gain",
                "share_unverifiable",
                "share_restatement",
                "mean_distance_weight",
                "share_invalid",
                "n_malformed",
                "mean_confidence",
                "step_cost_usd",
                "spent_usd",
                "stop_reason",
            )
        }
        | {"updated": r.get("river", {}).get("train/updated")}
        for r in curve
    ]
    checkpoints = {
        k: {"inference": state[k]["inference_path"], "periodic": [c["inference_path"] for c in state[k].get("periodic", [])]}
        for k in ("rl", "rl_correctness")
        if k in state and not state[k].get("skipped")
    }
    out = {
        "generated_at": datetime.now(UTC).isoformat(),
        "note": "Run-2 numbers use the distance-weighted reward; they are not comparable with run-1 numbers.",
        "units": "information gain in nats per read; intervals are bootstrap 95% over reads",
        "eval": evals,
        "eval_extras": extras,
        "vs_base": comparisons,
        "phase_curves": _phase_curves(curve, period=max(1, math.ceil(state["rl"]["training_episodes"] / RL_RUN2.groups_per_step))),
        "rl": {k: {kk: vv for kk, vv in state[k].items() if kk != "periodic"} for k in ("rl", "rl_correctness") if k in state},
        "steps": steps,
        "checkpoints": checkpoints,
        "spend": ledger.totals(),
    }
    (RUN2_DIR / "results.json").write_text(json.dumps(out, indent=1, default=str))
    return {"eval": evals, "vs_base": comparisons, "checkpoints": checkpoints, "spend": ledger.totals()}


STAGES = {
    "eval-base": stage_eval_base,
    "rl": stage_rl,
    "eval": stage_eval,
    "rl-correctness": stage_rl_correctness,
    "eval-correctness": stage_eval_correctness,
    "results": stage_results,
}
