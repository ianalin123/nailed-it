# nailed-it-training

Training pipeline for the Nailed It reader. It implements the "Training paradigm" section of the spec:
held-out verification, an information-gain reward over a measured base rate, gates, a deck-level
reward, a human-verdict critic that audits the verifier, and bandit card selection.

## What the demo proves

`nailed-it-train demo` runs stages A and B end to end. It uses a **fake backend**, a
**keyword verifier**, and **invented personas**, then prints the five-row ablation table.
**This proves the wiring, not model quality.** The fake "model" is a categorical distribution
over six hard-coded read-writing strategies, and the fake verifier matches phrases. The numbers in
the table say nothing about how a real reader would do. Nothing in this folder has trained or
sampled a real model.

## Commands

```fish
uv sync                                  # numpy + pydantic, plus pytest/hypothesis for dev
uv run pytest                            # full suite
uv run nailed-it-train demo --seed 1     # stages A + B + ablation on synthetic data (wiring check)
uv run nailed-it-train demo --seed 1 --with-verdicts   # also audits the verifier and trains the critic
```


## Layout

| Module | Spec | Job |
|---|---|---|
| `protocol.py` | protocol package | Pydantic mirror of `EvidenceItem`, `EvidenceDigest`, `Read`, `Deck`, `VerdictRecord` |
| `episodes.py` | Idea 1 | Temporal and leave-one-source-out splits, seeded |
| `verifier.py` | Idea 1 | `Verifier` protocol, `LlmVerifier` (injectable client, citation check), `KeywordVerifier` fake |
| `base_rate.py` | Idea 2, amendment 1 | `BaseRateJudge` with category shrinkage (default); population hit rate (alternative) |
| `reward.py` | Ideas 2 to 4 | `information_gain`, gates, `score_read`, `deck_reward` |
| `critic.py` | Idea 5, amendment 6 | Logistic-regression critic on verdict JSONL, Wilson-bound verifier audit |
| `selection.py` | Idea 6 | Thompson sampling over categories, priority by critic uncertainty and undecided verifier |
| `eval.py` | Eval | Benchmark metrics and the ablation table |
| `river_adapter.py` | Stages | `TrainerBackend` protocol, `RiverBackend`, `RiverLlmClient` |
| `ledger.py` | | Pricing table, spend ledger, hard cap |
| `smoke.py` | | First real River calls |
| `fake_backend.py` | | In-process backend for tests and the demo |
| `reader.py` | | Reader prompt and deck parsing |
| `pipeline.py`, `cli.py` | Stages A, B, Eval | Frozen benchmark, stage A filter, RL rows, ablation |
| `synthetic/` | | Invented personas, trait lexicon, synthetic verdicts |

## Reward design (spec + 2026-09-27 amendments)

- **Information gain.** `R = log score(c) - log score(b)`, clipped at eps = 0.01. A maximally confident miss scores about -3.9 nats against b = 0.5.
- **Assertion floor (amendment 2).** When confidence < 0.5, `R = min(R, 0)`. This applies to verified reads and to critic-scored reads.
- **Base rate (amendment 1).** The default source is `CategoryShrunkBaseRate(CachingJudge(LlmBaseRateJudge(...)))`. The judge sees no evidence and estimates P(true) for a random person in the population. That estimate is shrunk toward the running mean of the read's category, as `(4 * judged + 1 * category mean) / 5`. The first read in a category is not shrunk. The running mean depends on scoring order. `PopulationBaseRate` (hit rate on other people, shrunk toward 0.5) remains as an alternative for when a real population exists.
- **Restatement (amendment 3).** This is entailment only. The verifier runs on the visible items, and a read counts as a restatement if it is supported with a single citation at strength >= 0.5. Self-reported `hops` is ignored.
- **Grounding (amendment 4, plus chains).** A read is ungrounded (-1) if `evidenceIds` is empty or names a non-visible id, or if any chain evidence step fails to start with `[<visible id>]`, or if the chain has no evidence step. The TypeScript `ChainStep` has no id field, so the id travels inside the step's `text`. Recommendation: add `evidenceId?: string` to `ChainStep`.
- **Deck (amendment 5).** `mean(read rewards) - 1.0 * mean pairwise Jaccard + 0.5 * coverage - 0.25 * |n - 12|`. Wrong-size decks are penalised, not rescaled.
- **Audit (amendment 6).** Training stops only when the overlap has at least 30 reads and the Wilson 95% upper bound on agreement is below 0.75. Agreement is `mean(1 - |verifier - human|)`, so `partly` earns half credit.
- **Verifier contract (wave 3).** A verdict cites at most 3 items; more than 3 is rejected in code. "Supported" means the evidence would be surprising if the claim were false. Merely compatible evidence gets "unverifiable". `calibration.py` holds 20 invented claims with known answers (supported, contradicted, compatible, unrelated), and `score_verifier` grades any verifier; 80% is the bar for training. In training mode, a malformed verifier batch is retried once, then marked unverifiable and counted.
- **Evidence caps.** Each verifier call sees at most 80 items, chosen by lexical overlap with the deck's claims (round-robin, deterministic). The hidden and visible sides are selected separately and never mixed.
- **Per-read parsing at reward time.** Unparseable JSON costs the deck −2. A single invalid read (over 240 characters, bad category, bad chain) costs −1 and counts toward deck size.
- **Stage A.** Survivors from one episode are pooled and assembled into exact 12-read decks, matching RL. Episodes with fewer than 12 distinct survivors are skipped and counted.
- **Category means.** These are fit once from all stage A teacher reads and then frozen, so a read's base rate does not depend on its deck or the scoring order. Without frozen means, the per-batch mean is order-invariant.
- **Per-step metrics and early stop.** Each RL step appends to `.spend/metrics.jsonl`: reward, information gain, gate shares, unverifiable share, confidence, tokens, and cost. The run stops if the reward slope over 15 steps is ≤ 0, if the unverifiable share over the last 3 steps is above 0.7, or at $45. Named inference checkpoints are saved every 10 steps.
- **Cost control.** `CachingVerifier` keys on (read text hash, evidence-set hash). `CachingJudge` keys on the read text hash. `LlmVerifier` batches up to `batch_size` claims per call. Call and hit counts are available on `.stats`.
- **Spend ledger.** `SpendLedger` checks every River call's worst-case cost before the call, records the real token counts after, and persists to `.spend/ledger.jsonl` (gitignored), so the cap holds across processes. River reports `prompt_tokens=0` from `Client.sample`, so prompt tokens are counted locally with River's own renderer tokenizer.
- **Unverifiable reads.** Reward is `(1 - u) * E_critic[R]` with the assertion floor applied, or 0 without a critic.
- **Episodes.** Undated items are excluded from temporal splits by default. There is no visible-leak option.
- **Stage A.** A deck enters the verified SFT set only if at least 3 reads survive. Starvation raises `StageAStarvedError`.

## Training data

`pipeline.run_pipeline` takes owner-approved `EvidenceDigest`s and never imports `synthetic/`; a test enforces this. With one person, the benchmark is that person's latest 20% time window. The `demo` subcommand and the tests still use invented personas, and the demo is a wiring check only.

## River

```fish
uv sync --extra river
set -a; . ./.env.local; set +a            # RIVER_API_KEY, process environment only
set -x HF_HUB_DISABLE_XET 1               # the Xet download client does not go through the sandbox proxy
uv run nailed-it-train smoke a|b|c|calibrate   # reader sample, verifier + judge, minimal RL, verifier calibration
uv run nailed-it-train full freeze|stage-a|sft|rl-full|rl-correctness|eval|results   # the full run, resumable
```

## Caveats

- Undated items from training people stay in training, even though some may postdate the benchmark window.
- `RiverBackend.deploy` and endpoint sampling are not exercised, and endpoint sampling is refused because it cannot be metered.
- The notes are in `docs/working/river-notes.md`, which is gitignored and local.

## Data

`data/private/` is gitignored and belongs to another process. Nothing here reads it. Every fixture is generated by `synthetic/` from invented names and traits.
