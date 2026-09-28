"""Run 3 stages: train -> eval -> results -> blind. State in .spend/run3/state.json. Hard cap $35 total."""

import json
import random
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from nailed_it_training.full_run import BASE, Rig
from nailed_it_training.reader import render_reader_prompt
from nailed_it_training.river_adapter import CheckpointRef, ModelRef
from nailed_it_training.run2 import RUN2_DIR, _category_means, _deck_extras, _eval_target, _setup, _summary
from nailed_it_training.run3 import RiverPolicy, Run3Config, Trainer
from nailed_it_training.smoke import SPEND_DIR

RUN3_DIR = SPEND_DIR / "run3"
STATE = RUN3_DIR / "state.json"
METRICS = RUN3_DIR / "metrics.jsonl"
BLIND_DIR = SPEND_DIR / "blind"
CAP_USD = 35.0
CONFIG = Run3Config()
LR = 1e-5
LORA_RANK = 16
MAX_TOKENS = 4096
BASE_IG = 0.130
BASE_SUPPORTED = 0.315
BASE_RESTATEMENT = 0.441


def _load() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def _save(state: dict[str, Any]) -> None:
    RUN3_DIR.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1, default=str))


def stage_train() -> dict[str, Any]:
    state = _load()
    if "train" in state:
        return state["train"]
    training, _ = _setup()
    rig = Rig(_category_means(), cap_usd=CAP_USD)
    backend = rig.backend
    renderer = backend.renderer(BASE)
    tokenizer = renderer.tokenizer
    prompts = {}
    for e in training:
        system, user = render_reader_prompt(e)
        prompts[e.episode_id] = list(tokenizer.encode(backend._prompt(BASE, system, user), add_special_tokens=False))
    started = datetime.now(UTC)
    spent_before = rig.ledger.spent
    import river_client as river

    with backend._client.session(experiment=CONFIG.name) as session:
        model = session.create_model(base_model=BASE, tokenizer=tokenizer, lora=river.LoraConfig(rank=LORA_RANK, seed=CONFIG.seed))
        policy = RiverPolicy(backend, model, BASE, rig.ledger, max_tokens=MAX_TOKENS, lr=LR, stop=renderer.get_stop_strings())
        trainer = Trainer(
            policy, tokenizer, rig.scorer, {e.episode_id: e for e in training}, prompts, CONFIG, metrics_path=METRICS, ledger=rig.ledger
        )
        try:
            result = trainer.run()
        except Exception as err:
            crash = policy.save(f"{CONFIG.name}-at-error")
            state["train_crash"] = {"error": f"{type(err).__name__}: {str(err)[:300]}", "checkpoint": asdict(crash)}
            _save(state)
            raise
    state["train"] = {
        "steps_done": result.steps_done,
        "stop_reason": result.stop_reason,
        "checkpoints": result.checkpoints,
        "minutes": (datetime.now(UTC) - started).total_seconds() / 60,
        "spent_usd": rig.ledger.spent - spent_before,
        "training_episodes": len(training),
        "verifier": vars(rig.inner_verifier.stats),
    }
    _save(state)
    return state["train"]


def stage_eval() -> dict[str, Any]:
    state = _load()
    _, benchmark = _setup()
    rig = Rig(_category_means(), cap_usd=CAP_USD)
    targets = {
        f"run3_step{c['step']:03d}": ModelRef(
            BASE, CheckpointRef(training_path=c["training_path"], inference_path=c["inference_path"], base_model=c["base_model"])
        )
        for c in state["train"]["checkpoints"]
    }
    results: dict[str, Any] = state.get("eval", {})
    todo = {k: v for k, v in targets.items() if k not in results}
    with ThreadPoolExecutor(max_workers=max(1, len(todo))) as pool:
        futures = {k: pool.submit(_eval_target, rig, k, t, benchmark, RUN3_DIR) for k, t in todo.items()}
        for k, f in futures.items():
            results[k] = f.result()
            state = _load()
            state["eval"] = {**state.get("eval", {}), k: results[k]}
            _save(state)
    return {"eval": {k: _summary(v) for k, v in results.items()}, "spent": rig.ledger.spent}


def _extras(name: str) -> dict[str, Any]:
    import nailed_it_training.run2 as run2

    original = run2.RUN2_DIR
    run2.RUN2_DIR = RUN3_DIR
    try:
        return _deck_extras(name)
    finally:
        run2.RUN2_DIR = original


def verdict(summary: dict[str, Any], extras: dict[str, Any]) -> str:
    """Fixed in advance: improved / worse / not distinguishable against run 2's base row."""
    if summary["ig_ci_low"] > BASE_IG:
        return "improved (information gain)"
    if extras["supported_share_ci"][0] > BASE_SUPPORTED and summary["restatement_rate"] <= BASE_RESTATEMENT:
        return "improved (supported share)"
    if summary["ig_ci_high"] < BASE_IG:
        return "worse (information gain)"
    return "not distinguishable"


def stage_results() -> dict[str, Any]:
    state = _load()
    from nailed_it_training.ledger import SpendLedger
    from nailed_it_training.smoke import LEDGER_PATH

    run2_state = json.loads((RUN2_DIR / "state.json").read_text())
    base = _summary(run2_state["eval"]["base"])
    rows = {}
    for name, metrics in sorted(state["eval"].items()):
        summary = _summary(metrics)
        extras = _extras(name)
        rows[name] = {**summary, **extras, "verdict": verdict(summary, extras)}
    curve = [json.loads(line) for line in METRICS.read_text().splitlines()] if METRICS.exists() else []
    out = {
        "generated_at": datetime.now(UTC).isoformat(),
        "note": "Benchmark metric identical to run 2; base row reused from run 2. The -0.1 restatement penalty is training-only.",
        "decision_rule": {
            "improved": (
                f"IG 95% CI entirely above {BASE_IG}, or supported-share CI entirely above {BASE_SUPPORTED} "
                f"with restatement <= {BASE_RESTATEMENT}"
            ),
            "worse": f"IG 95% CI entirely below {BASE_IG}",
            "otherwise": "not distinguishable",
        },
        "base_run2": {**base, **json.loads(json.dumps(run2_state.get("base_extras", {})))},
        "checkpoints": rows,
        "train": state.get("train"),
        "steps": [{k: v for k, v in r.items() if k not in ("per_episode_ig", "at")} for r in curve],
        "spend": SpendLedger(cap_usd=CAP_USD, path=LEDGER_PATH).totals(),
    }
    (RUN3_DIR / "results.json").write_text(json.dumps(out, indent=1, default=str))
    return {
        "checkpoints": {
            k: {
                kk: v[kk]
                for kk in (
                    "mean_information_gain",
                    "ig_ci_low",
                    "ig_ci_high",
                    "supported_share",
                    "supported_share_ci",
                    "restatement_rate",
                    "n_decided",
                    "verified_accuracy",
                    "verdict",
                )
            }
            for k, v in rows.items()
        },
        "spend": out["spend"],
    }


def _pick(reads: list[dict[str, Any]], k: int, rng: random.Random) -> list[dict[str, Any]]:
    by_category: dict[str, list[dict[str, Any]]] = {}
    for r in reads:
        by_category.setdefault(r["category"], []).append(r)
    for pool in by_category.values():
        rng.shuffle(pool)
    picked: list[dict[str, Any]] = []
    categories = sorted(by_category)
    while len(picked) < k and any(by_category[c] for c in categories):
        for c in categories:
            if by_category[c] and len(picked) < k:
                picked.append(by_category[c].pop())
    if len(picked) < k:
        raise ValueError(f"only {len(picked)} eligible reads, need {k}")
    return picked


def stage_blind(per_model: int = 30, seed: int = 20260928) -> dict[str, Any]:
    state = _load()
    rows = json.loads((RUN3_DIR / "results.json").read_text())["checkpoints"]
    improved = [k for k, v in sorted(rows.items()) if v["verdict"].startswith("improved")]
    trained = improved[0] if improved else max(rows)
    sources = {"base": RUN2_DIR / "eval_decks_base.json", trained: RUN3_DIR / f"eval_decks_{trained}.json"}
    rng = random.Random(seed)
    pool: list[dict[str, Any]] = []
    key: dict[str, Any] = {}
    for source, path in sources.items():
        reads = [r for d in json.loads(path.read_text()) for r in d["reads"] if r["gate"] == "passed"]
        for r in _pick(reads, per_model, rng):
            opaque = f"{rng.getrandbits(48):012x}"
            pool.append({"id": opaque, "text": r["text"], "category": r["category"], "confidence": r["confidence"]})
            key[opaque] = {"source": source, "outcome": r["outcome"], "reward": r["reward"]}
    rng.shuffle(pool)
    BLIND_DIR.mkdir(parents=True, exist_ok=True)
    (BLIND_DIR / "pool.json").write_text(json.dumps({"reads": pool}, indent=1, ensure_ascii=False))
    (BLIND_DIR / "key.json").write_text(
        json.dumps({"trained_source": trained, "selection": "best-by-rule" if improved else "final (none improved)", "key": key}, indent=1)
    )
    state["blind"] = {"trained_source": trained, "n": len(pool)}
    _save(state)
    return state["blind"]


STAGES: dict[str, Callable[[], dict[str, Any]]] = {"train": stage_train, "eval": stage_eval, "results": stage_results, "blind": stage_blind}
