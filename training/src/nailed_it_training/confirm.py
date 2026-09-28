"""Confirmation evaluation of run-3 step 5 against the base model. No training.

Declared in advance: 40 new benchmark decks per arm with unused seeds, interleaved sampling and scoring, only new
decks for the verdict, primary metric = difference in mean information gain per read (step 5 minus base) with a
two-sample bootstrap resampling DECKS. Verdict: confirmed (CI > 0), not confirmed (CI contains 0), reversed (CI < 0).
"""

import json
import random
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

N_BOOT = 10_000
BOOT_SEED = 20260928
SAMPLE_SEEDS = (101, 102)
DECKS_PER_CALL = 10


@dataclass(frozen=True)
class DeckStat:
    numerator: float
    denominator: float


def _ratio(decks: Sequence[DeckStat]) -> float:
    den = sum(d.denominator for d in decks)
    if den == 0:
        raise ValueError("ratio undefined: zero denominator")
    return sum(d.numerator for d in decks) / den


def _percentile(sorted_values: list[float], q: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, max(0, int(q * len(sorted_values))))]


def deck_bootstrap_ratio(decks: Sequence[DeckStat], *, n_boot: int = N_BOOT, seed: int = BOOT_SEED) -> tuple[float, float, float]:
    """Point estimate and percentile 95% interval of a per-read ratio, resampling whole decks."""
    if not decks:
        raise ValueError("no decks")
    rng = random.Random(seed)
    n = len(decks)
    boots = sorted(_ratio([decks[rng.randrange(n)] for _ in range(n)]) for _ in range(n_boot))
    return _ratio(decks), _percentile(boots, 0.025), _percentile(boots, 0.975)


def deck_bootstrap_diff(a: Sequence[DeckStat], b: Sequence[DeckStat], *, n_boot: int = N_BOOT, seed: int = BOOT_SEED) -> tuple[float, float, float]:
    """Difference of per-read ratios (a minus b), resampling decks independently within each arm."""
    if not a or not b:
        raise ValueError("both arms need decks")
    rng = random.Random(seed)
    na, nb = len(a), len(b)
    boots = sorted(_ratio([a[rng.randrange(na)] for _ in range(na)]) - _ratio([b[rng.randrange(nb)] for _ in range(nb)]) for _ in range(n_boot))
    return _ratio(a) - _ratio(b), _percentile(boots, 0.025), _percentile(boots, 0.975)


def verdict(lo: float, hi: float) -> str:
    if lo > 0:
        return "confirmed"
    if hi < 0:
        return "reversed"
    return "not confirmed"


def interleave(a: Sequence[Any], b: Sequence[Any]) -> list[Any]:
    out: list[Any] = []
    for i in range(max(len(a), len(b))):
        if i < len(a):
            out.append(a[i])
        if i < len(b):
            out.append(b[i])
    return out


METRICS: dict[str, Callable[[dict[str, Any]], DeckStat]] = {
    "information_gain_per_read": lambda d: DeckStat(sum(r["reward"] for r in d["reads"] if r["outcome"] is not None), len(d["reads"])),
    "supported_share": lambda d: DeckStat(sum(r["outcome"] == 1 for r in d["reads"]), len(d["reads"])),
    "restatement_rate": lambda d: DeckStat(sum(r["gate"] == "restatement" for r in d["reads"]), len(d["reads"])),
    "unverifiable_share": lambda d: DeckStat(
        sum(r["outcome"] is None for r in d["reads"] if r["gate"] == "passed"), sum(r["gate"] == "passed" for r in d["reads"])
    ),
    "invalid_read_rate": lambda d: DeckStat(d["n_invalid"], len(d["reads"]) + d["n_invalid"]),
}


def summarise(arm_a: list[dict[str, Any]], arm_b: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-arm ratio intervals and the a-minus-b difference interval for every metric, all deck-resampled."""
    out: dict[str, Any] = {}
    for name, stat in METRICS.items():
        a = [stat(d) for d in arm_a if stat(d).denominator > 0]
        b = [stat(d) for d in arm_b if stat(d).denominator > 0]
        out[name] = {
            "step005": list(deck_bootstrap_ratio(a)),
            "base": list(deck_bootstrap_ratio(b)),
            "difference_step005_minus_base": list(deck_bootstrap_diff(a, b)),
            "decks": {"step005": len(a), "base": len(b)},
        }
    return out


def run_confirmation() -> dict[str, Any]:
    from nailed_it_training.calibration import score_verifier
    from nailed_it_training.full_run import BASE, Rig, _deck_json
    from nailed_it_training.reader import MalformedDeckError, parse_deck, render_reader_prompt
    from nailed_it_training.river_adapter import CheckpointRef, ModelRef
    from nailed_it_training.run2 import RUN2_DIR, _category_means, _setup
    from nailed_it_training.run3_stages import RUN3_DIR
    from nailed_it_training.run3_stages import _load as load_run3
    from nailed_it_training.smoke import SPEND_DIR
    from nailed_it_training.verifier import LlmVerifier

    out_dir = SPEND_DIR / "confirm"
    out_dir.mkdir(parents=True, exist_ok=True)
    state_path = out_dir / "state.json"
    state: dict[str, Any] = json.loads(state_path.read_text()) if state_path.exists() else {}

    def save() -> None:
        state_path.write_text(json.dumps(state, indent=1, default=str))

    _, benchmark = _setup()
    rig = Rig(_category_means(), cap_usd=45.0)
    state.setdefault("spent_at_start", rig.ledger.spent)

    def calibrate(label: str) -> dict[str, Any]:
        verifier = LlmVerifier(rig.backend.llm_client(BASE, max_tokens=1024, label=f"confirm:calibrate:{label}"), on_ungrounded="raise")
        result = score_verifier(verifier)
        return {
            "accuracy": result.accuracy,
            "correct": result.correct,
            "total": result.total,
            "by_kind": {k.value: v for k, v in result.by_kind.items()},
            "errors": list(result.errors),
            "at": datetime.now(UTC).isoformat(),
        }

    if "calibration_start" not in state:
        state["calibration_start"] = calibrate("start")
        save()

    step5 = next(c for c in load_run3()["train"]["checkpoints"] if c["step"] == 5)
    arms = {
        "base": ModelRef(BASE),
        "step005": ModelRef(BASE, CheckpointRef(step5["training_path"], step5["inference_path"], step5["base_model"])),
    }
    samples_path = out_dir / "samples.json"
    samples: dict[str, list[str]] = json.loads(samples_path.read_text()) if samples_path.exists() else {}
    for round_index, seed in enumerate(SAMPLE_SEEDS):
        order = ["base", "step005"] if round_index % 2 == 0 else ["step005", "base"]
        for episode in benchmark.episodes:
            system, user = render_reader_prompt(episode)
            for arm in order:
                key = f"{arm}|{episode.episode_id}|{seed}"
                if key in samples:
                    continue
                samples[key] = rig.backend.sample(arms[arm], system=system, user=user, n=DECKS_PER_CALL, max_tokens=4096, temperature=0.7, seed=seed)
                samples_path.write_text(json.dumps(samples))

    by_id = {e.episode_id: e for e in benchmark.episodes}
    jobs: dict[str, list[tuple[str, int, str]]] = {"base": [], "step005": []}
    for key, texts in samples.items():
        arm, episode_id, seed_text = key.split("|")
        jobs[arm].extend((episode_id, int(seed_text), t) for t in texts)
    ordered = interleave([("base", *j) for j in jobs["base"]], [("step005", *j) for j in jobs["step005"]])
    malformed = {"base": 0, "step005": 0}

    def score(job: tuple[str, str, int, str]) -> tuple[str, dict[str, Any] | None]:
        arm, episode_id, seed, text = job
        try:
            parsed = parse_deck(text, model_version=arm)
        except MalformedDeckError:
            return arm, None
        deck = rig.scorer.score(by_id[episode_id], parsed.reads, n_invalid=len(parsed.errors))
        return arm, {**_deck_json(episode_id, deck), "seed": seed}

    decks_path = out_dir / "decks.json"
    if decks_path.exists():
        scored_decks: dict[str, list[dict[str, Any]]] = json.loads(decks_path.read_text())
    else:
        with ThreadPoolExecutor(max_workers=8) as pool:
            scored = list(pool.map(score, ordered))
        scored_decks = {"base": [], "step005": []}
        for arm, deck in scored:
            if deck is None:
                malformed[arm] += 1
            else:
                scored_decks[arm].append(deck)
        decks_path.write_text(json.dumps(scored_decks))
        state["malformed"] = malformed
        save()

    if "calibration_end" not in state:
        state["calibration_end"] = calibrate("end")
        save()

    new = summarise(scored_decks["step005"], scored_decks["base"])
    ig = new["information_gain_per_read"]["difference_step005_minus_base"]
    original_base = json.loads((RUN2_DIR / "eval_decks_base.json").read_text())
    original_step5 = json.loads((RUN3_DIR / "eval_decks_run3_step005.json").read_text())
    pooled = summarise(scored_decks["step005"] + original_step5, scored_decks["base"] + original_base)
    results: dict[str, Any] = {
        "generated_at": datetime.now(UTC).isoformat(),
        "design": {
            "decks_per_arm_requested": DECKS_PER_CALL * len(SAMPLE_SEEDS) * len(benchmark.episodes),
            "sample_seeds": list(SAMPLE_SEEDS),
            "temperature": 0.7,
            "bootstrap": {"unit": "deck", "n_boot": N_BOOT, "seed": BOOT_SEED, "interval": "percentile 95%"},
            "interleaving": "sampling alternates arms per episode, arm order flips between seeds; scoring interleaves arms",
        },
        "primary": {
            "metric": "mean information gain per read, step005 minus base (new decks only)",
            "difference": ig[0],
            "ci95": [ig[1], ig[2]],
            "verdict": verdict(ig[1], ig[2]),
        },
        "new_decks": new,
        "decks_scored": {k: len(v) for k, v in scored_decks.items()},
        "malformed": state.get("malformed"),
        "pooled_including_selection_data": {
            "note": "Includes the original 20 decks per row that selected step 5; biased upward. Not used for the verdict.",
            **pooled,
        },
        "calibration": {"start": state["calibration_start"], "end": state["calibration_end"]},
        "spend": {"at_start": state["spent_at_start"], "at_end": rig.ledger.spent, "this_eval": rig.ledger.spent - state["spent_at_start"]},
    }
    (out_dir / "results.json").write_text(json.dumps(results, indent=1, default=str))
    return {
        "primary": results["primary"],
        "decks_scored": results["decks_scored"],
        "malformed": results["malformed"],
        "calibration": {"start": state["calibration_start"]["accuracy"], "end": state["calibration_end"]["accuracy"]},
        "spend": results["spend"],
    }
