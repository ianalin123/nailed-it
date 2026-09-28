"""nailed-it-train: run the synthetic end-to-end demo against the fake backend and fake verifier."""

import argparse
import sys
from collections.abc import Sequence
from dataclasses import replace

from nailed_it_training.base_rate import CategoryShrunkBaseRate
from nailed_it_training.fake_backend import FakeBackend
from nailed_it_training.pipeline import PipelineConfig, VerifierDistrustedError, run_pipeline
from nailed_it_training.synthetic import LexiconJudge, generate_personas, keyword_rules, synthetic_verdicts
from nailed_it_training.verifier import CachingVerifier, KeywordVerifier

DISCLAIMER = (
    "This run uses a fake backend, a keyword verifier, a lexicon base-rate judge and invented personas. It proves the pipeline wiring. "
    "The numbers say nothing about model quality."
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nailed-it-train")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="stages A and B on synthetic data, then the ablation table")
    demo.add_argument("--seed", type=int, default=0)
    demo.add_argument("--people", type=int, default=12, help="invented people; the last two are held out")
    demo.add_argument("--sft-steps", type=int, default=20)
    demo.add_argument("--rl-steps", type=int, default=20)
    demo.add_argument("--with-verdicts", action="store_true", help="also audit the verifier and train a critic on synthetic verdicts")
    smoke = sub.add_parser("smoke", help="first real River calls under the $5 wave cap (needs RIVER_API_KEY in the environment)")
    smoke.add_argument("step", choices=["a", "b", "c", "calibrate"])
    full = sub.add_parser("full", help="the first full training run, one resumable stage at a time")
    full.add_argument("stage", choices=["freeze", "stage-a", "sft", "rl-full", "rl-correctness", "eval", "results"])
    run2 = sub.add_parser("run2", help="run 2: RL from base with the distance-weighted reward, resumable stages")
    run2.add_argument("stage", choices=["eval-base", "rl", "eval", "rl-correctness", "eval-correctness", "results"])
    run3 = sub.add_parser("run3", help="run 3: per-read credit assignment with River primitives")
    run3.add_argument("stage", choices=["train", "eval", "results", "blind"])
    return parser


def _run3(stage: str) -> int:
    import json

    from nailed_it_training import run3_stages

    print(json.dumps(run3_stages.STAGES[stage](), indent=1, default=str))
    return 0


def _run2(stage: str) -> int:
    import json

    from nailed_it_training import run2

    print(json.dumps(run2.STAGES[stage](), indent=1, default=str))
    return 0


def _full(stage: str) -> int:
    import json

    from nailed_it_training import full_run

    print(json.dumps(full_run.STAGES[stage](), indent=1, default=str))
    return 0


def _smoke(step: str) -> int:
    import json

    from nailed_it_training import smoke

    runner = {"a": smoke.step_a, "b": smoke.step_b, "c": smoke.step_c, "calibrate": smoke.step_calibrate}[step]
    print(json.dumps(runner(), indent=1, default=str))
    return 0


def _demo(args: argparse.Namespace) -> int:
    personas = generate_personas(args.people, args.seed)
    if len(personas) < 3:
        raise SystemExit("--people must be at least 3 so two can be held out")
    digests = [p.digest for p in personas]
    config = replace(
        PipelineConfig(),
        seed=args.seed,
        heldout_digest_ids=frozenset(d.digest_id for d in digests[-2:]),
        teacher_decks_per_episode=8,
        sft_steps=args.sft_steps,
        rl_steps=args.rl_steps,
    )
    verdicts = synthetic_verdicts(personas[:-2], reads_per_person=6, seed=args.seed) if args.with_verdicts else None
    print(DISCLAIMER)
    try:
        result = run_pipeline(
            FakeBackend(seed=config.seed),
            CachingVerifier(KeywordVerifier(keyword_rules())),
            CategoryShrunkBaseRate(LexiconJudge()),
            digests,
            config,
            verdicts=verdicts,
        )
    except VerifierDistrustedError as err:
        print(f"Training halted by the verifier audit: {err}", file=sys.stderr)
        return 2
    print()
    print(
        f"Stage A: {result.stage_a.n_teacher_reads} teacher reads, {len(result.stage_a.survivors)} survived, "
        f"{len(result.stage_a.verified_examples)} SFT examples, {result.stage_a.n_malformed} malformed decks"
    )
    if result.audit is not None:
        agreement = "n/a" if result.audit.agreement is None else f"{result.audit.agreement:.3f}"
        print(f"Verifier audit: agreement {agreement} on {result.audit.overlap} reads, status {result.audit.status.value}")
    for row, history in result.reward_history.items():
        print(f"RL reward {row.label}: first step {history[0]:.3f}, last step {history[-1]:.3f}")
    print()
    print(result.table)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "demo":
        return _demo(args)
    if args.command == "smoke":
        return _smoke(args.step)
    if args.command == "full":
        return _full(args.stage)
    if args.command == "run2":
        return _run2(args.stage)
    if args.command == "run3":
        return _run3(args.stage)
    raise AssertionError(f"unhandled command {args.command}")


if __name__ == "__main__":
    sys.exit(main())
