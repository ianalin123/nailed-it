"""nailed-it-train: run the synthetic end-to-end demo against the fake backend and fake verifier."""

import argparse
import sys
from collections.abc import Sequence
from dataclasses import replace

from nailed_it_training.fake_backend import FakeBackend
from nailed_it_training.pipeline import PipelineConfig, VerifierDistrustedError, run_pipeline
from nailed_it_training.synthetic import generate_personas, keyword_rules, synthetic_verdicts
from nailed_it_training.verifier import KeywordVerifier

DISCLAIMER = (
    "This run uses a fake backend, a keyword verifier and invented personas. It proves the pipeline wiring. "
    "The numbers say nothing about model quality."
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nailed-it-train")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="stages A and B on synthetic data, then the ablation table")
    demo.add_argument("--seed", type=int, default=0)
    demo.add_argument("--train-personas", type=int, default=12)
    demo.add_argument("--eval-personas", type=int, default=3)
    demo.add_argument("--sft-steps", type=int, default=20)
    demo.add_argument("--rl-steps", type=int, default=20)
    demo.add_argument("--with-verdicts", action="store_true", help="also audit the verifier and train a critic on synthetic verdicts")
    return parser


def _demo(args: argparse.Namespace) -> int:
    config = replace(
        PipelineConfig(),
        seed=args.seed,
        n_train_personas=args.train_personas,
        n_eval_personas=args.eval_personas,
        sft_steps=args.sft_steps,
        rl_steps=args.rl_steps,
    )
    personas = generate_personas(config.n_train_personas + config.n_eval_personas, config.seed)
    verdicts = (
        synthetic_verdicts(personas[: config.n_train_personas], reads_per_person=6, seed=config.seed) if args.with_verdicts else None
    )
    print(DISCLAIMER)
    try:
        result = run_pipeline(FakeBackend(seed=config.seed), KeywordVerifier(keyword_rules()), config, personas=personas, verdicts=verdicts)
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
    raise AssertionError(f"unhandled command {args.command}")


if __name__ == "__main__":
    sys.exit(main())
