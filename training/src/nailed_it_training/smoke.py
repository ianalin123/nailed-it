"""First real River calls, one step at a time, under a persistent spend cap. No retries: any error stops the step.

Raw completions are written to .spend/smoke/ (gitignored). stdout carries shapes and counts only.
"""

import json
import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from nailed_it_training.base_rate import CachingJudge, CategoryShrunkBaseRate, LlmBaseRateJudge
from nailed_it_training.episodes import Episode, SplitConfig, build_episodes
from nailed_it_training.ledger import SpendLedger
from nailed_it_training.pipeline import DeckScorer, PipelineConfig, information_gain_reward
from nailed_it_training.protocol import EvidenceDigest, EvidenceItem, SourceKind
from nailed_it_training.reader import MalformedDeckError, parse_reads, render_reader_prompt
from nailed_it_training.reward import RewardConfig
from nailed_it_training.river_adapter import ModelRef, RiverBackend, RlConfig, RlRow
from nailed_it_training.verifier import CachingVerifier, LlmVerifier

BASE_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"
TRAINING_ROOT = Path(__file__).resolve().parents[2]
SPEND_DIR = TRAINING_ROOT / ".spend"
LEDGER_PATH = SPEND_DIR / "ledger.jsonl"
REAL_DIGEST = TRAINING_ROOT / "data" / "private" / "iana.digest.json"
WAVE_CAP_USD = 5.0
MAX_VISIBLE = 40

_T0 = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
_FICTIONAL: list[tuple[SourceKind, str]] = [
    (SourceKind.GIT_HISTORY, "Committed 'rewrite tide-table parser' at 01:52."),
    (SourceKind.MEETING_NOTES, "Asked to move the Monday sync to a written update instead."),
    (SourceKind.CLAUDE_SESSIONS, "Spent two hours with Claude arguing about whether to use a state machine for the ferry booking flow."),
    (SourceKind.CALENDAR, "Blocked Saturday mornings: 'sea swim, no laptop'."),
    (SourceKind.PROJECT_FILES, "README for a side project: a synth that turns tide data into drones."),
    (SourceKind.EMAIL, "Declined a conference talk: 'I would rather ship the thing than talk about it.'"),
    (SourceKind.GIT_HISTORY, "Committed 'delete half the tests, they tested the mocks' at 23:40."),
    (SourceKind.CLAUDE_MEMORY, "Prefers terse answers; asked the assistant to stop summarising at the end."),
    (SourceKind.MEETING_NOTES, "Volunteered to rewrite the onboarding doc after two new hires got lost."),
    (SourceKind.CALENDAR, "Booked a one-way ferry to the islands for the last week of the quarter."),
]


def fictional_digest() -> EvidenceDigest:
    """Invented person for smoke calls when the real digest is absent. Nobody real."""
    items = [
        EvidenceItem(id=f"tv-{i:02d}", source=src, text=text, observed_at=_T0 + timedelta(days=9 * i))
        for i, (src, text) in enumerate(_FICTIONAL)
    ]
    created = _T0 + timedelta(days=120)
    return EvidenceDigest(protocol_version=1, digest_id="fictional-tamsin", display_name="Tamsin Vell", created_at=created, items=items)


def load_digest() -> tuple[EvidenceDigest, str]:
    if REAL_DIGEST.exists():
        return EvidenceDigest.model_validate_json(REAL_DIGEST.read_text()), "real"
    return fictional_digest(), "fictional"


def _capped(episode: Episode) -> Episode:
    return replace(episode, visible=episode.visible[-MAX_VISIBLE:])


def episodes_for(digest: EvidenceDigest) -> list[Episode]:
    return [_capped(e) for e in build_episodes(digest, SplitConfig(n_temporal=2, min_visible=3, min_hidden=2), seed=0)]


def _backend() -> tuple[RiverBackend, SpendLedger]:
    if not os.environ.get("RIVER_API_KEY"):
        raise SystemExit("RIVER_API_KEY is not in the environment")
    ledger = SpendLedger(cap_usd=WAVE_CAP_USD, path=LEDGER_PATH)
    return RiverBackend.from_env(ledger, thinking=False, step_log=SPEND_DIR / "smoke" / "rl_steps.jsonl"), ledger


def _dump(name: str, payload: object) -> Path:
    out = SPEND_DIR / "smoke" / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1, default=str))
    return out


def _sample_shape(samples: list[Any]) -> dict[str, object]:
    first = samples[0]
    return {
        "container": type(samples).__name__,
        "len": len(samples),
        "element": type(first).__name__,
        "stop_reasons": [s.stop_reason for s in samples],
        "prompt_tokens": [s.prompt_tokens for s in samples],
        "cached_prompt_tokens": [s.cached_prompt_tokens for s in samples],
        "completion_tokens": [len(s.tokens) for s in samples],
        "has_think_block": ["<think>" in s.text for s in samples],
    }


def step_a() -> dict[str, object]:
    backend, ledger = _backend()
    digest, kind = load_digest()
    episode = episodes_for(digest)[0]
    system, user = render_reader_prompt(episode)
    prompt = backend._prompt(BASE_MODEL, system, user)
    samples = backend.sample_raw(ModelRef(BASE_MODEL), prompt, n=2, max_tokens=4096, temperature=0.8, seed=0, label="smoke:a:reader")
    parsed: list[dict[str, object]] = []
    for s in samples:
        try:
            reads = parse_reads(s.text, model_version=BASE_MODEL)
            parsed.append({"ok": True, "n_reads": len(reads), "all_have_chain": all(r.chain for r in reads)})
        except MalformedDeckError as err:
            parsed.append({"ok": False, "error": str(err)[:300]})
    _dump("a_reader", {"texts": [s.text for s in samples]})
    return {"digest": kind, "visible": len(episode.visible), "shape": _sample_shape(samples), "parsed": parsed, "ledger": ledger.totals()}


def step_b() -> dict[str, object]:
    backend, ledger = _backend()
    digest, kind = load_digest()
    episode = episodes_for(digest)[0]
    raw = json.loads((SPEND_DIR / "smoke" / "a_reader.json").read_text())["texts"]
    reads = parse_reads(raw[0], model_version=BASE_MODEL)[:4]
    verifier = LlmVerifier(backend.llm_client(BASE_MODEL, max_tokens=2048, label="smoke:b:verifier"), batch_size=12)
    verdicts = verifier.verify_many([r.text for r in reads], episode.hidden)
    judge = LlmBaseRateJudge(backend.llm_client(BASE_MODEL, max_tokens=1024, label="smoke:b:judge"))
    rates = judge.judge_many([(r.text, r.category) for r in reads])
    _dump("b_verifier_judge", {"verdicts": [v.model_dump() for v in verdicts], "base_rates": rates})
    return {
        "digest": kind,
        "verifier_calls": verifier.stats.calls,
        "labels": [v.label.value for v in verdicts],
        "cited_counts": [len(v.cited_ids) for v in verdicts],
        "judge_calls": judge.stats.calls,
        "base_rates": rates,
        "ledger": ledger.totals(),
    }


def step_c() -> dict[str, object]:
    backend, ledger = _backend()
    digest, kind = load_digest()
    episodes = episodes_for(digest)[:2]
    inner_verifier = LlmVerifier(
        backend.llm_client(BASE_MODEL, max_tokens=3072, label="smoke:c:verifier"), batch_size=12, on_ungrounded="reject"
    )
    verifier = CachingVerifier(inner_verifier)
    judge = CachingJudge(LlmBaseRateJudge(backend.llm_client(BASE_MODEL, max_tokens=1536, label="smoke:c:judge")))
    scorer = DeckScorer(verifier, CategoryShrunkBaseRate(judge), RewardConfig())
    reward_errors: list[str] = []
    reward_values: list[float] = []
    base_reward = information_gain_reward(scorer, {e.episode_id: e for e in episodes}, PipelineConfig())

    def reward(row: RlRow, completion: str) -> float:
        try:
            value = base_reward(row, completion)
        except Exception as err:
            reward_errors.append(f"{type(err).__name__}: {str(err)[:200]}")
            raise
        reward_values.append(value)
        return value

    rows = [RlRow(row_id=e.episode_id, system=s, user=u) for e in episodes for s, u in [render_reader_prompt(e)]]
    config = RlConfig(
        name="smoke-rl",
        base_model=BASE_MODEL,
        steps=2,
        group_size=2,
        groups_per_step=2,
        lr=1e-5,
        lora_rank=8,
        max_generated_tokens=4096,
        max_context_tokens=16384,
        temperature=1.0,
    )
    ckpt = backend.run_rl(rows, reward, config)
    system, user = render_reader_prompt(episodes[0])
    after = backend.sample_raw(
        ModelRef(BASE_MODEL, ckpt), backend._prompt(BASE_MODEL, system, user), n=1, max_tokens=4096, temperature=0.8, seed=1, label="smoke:c:ckpt"
    )
    try:
        parse_reads(after[0].text, model_version="smoke-rl")
        ckpt_parse = "ok"
    except MalformedDeckError as err:
        ckpt_parse = f"malformed: {str(err)[:200]}"
    _dump("c_rl", {"rewards": reward_values, "steps": backend.last_rl_steps, "ckpt_text": after[0].text})
    return {
        "digest": kind,
        "checkpoint": {"training": ckpt.training_path, "inference": ckpt.inference_path},
        "reward_calls": len(reward_values),
        "rewards": [round(v, 3) for v in reward_values],
        "reward_errors": reward_errors,
        "steps": [{k: v for k, v in st.items() if k in ("n", "model_step") or k.startswith(("reward/", "train/"))} for st in backend.last_rl_steps],
        "verifier_cache": vars(verifier.stats),
        "verifier_rejected": inner_verifier.stats.rejected,
        "judge_cache": vars(judge.stats),
        "ckpt_sample_shape": _sample_shape(after),
        "ckpt_parse": ckpt_parse,
        "ledger": ledger.totals(),
    }
