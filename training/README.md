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
uv run nailed-it-train demo --seed 1     # stages A + B + ablation on synthetic data
uv run nailed-it-train demo --seed 1 --with-verdicts   # also audits the verifier and trains the critic
```

With `--with-verdicts`, the synthetic human labels carry 10% flips and 10% `partly`. At `--seed 0`
the audit comes out at 0.713 < 0.75, so training halts with exit code 2. That is the stop rule
working as designed, not a bug. See the caveats below.

River (not runnable yet, since no key has been issued):

```fish
uv sync --extra river                    # river-client, transformers, openai
set -x RIVER_API_KEY rv_...              # environment only; never written to a file
```

## Layout

| Module | Spec | Job |
|---|---|---|
| `protocol.py` | protocol package | Pydantic mirror of `EvidenceItem`, `EvidenceDigest`, `Read`, `Deck`, `VerdictRecord` |
| `episodes.py` | Idea 1 | Temporal and leave-one-source-out splits, seeded |
| `verifier.py` | Idea 1 | `Verifier` protocol, `LlmVerifier` (injectable client, citation check), `KeywordVerifier` fake |
| `base_rate.py` | Idea 2 | Hit rate on other people, shrunk toward 0.5 |
| `reward.py` | Ideas 2 to 4 | `information_gain`, gates, `score_read`, `deck_reward` |
| `critic.py` | Idea 5 | Logistic-regression critic on verdict JSONL, verifier audit, 0.75 stop |
| `selection.py` | Idea 6 | Thompson sampling over categories, priority by critic uncertainty and undecided verifier |
| `eval.py` | Eval | Benchmark metrics and the ablation table |
| `river_adapter.py` | Stages | `TrainerBackend` protocol and `RiverBackend` |
| `fake_backend.py` | | In-process backend for tests and the demo |
| `reader.py` | | Reader prompt and deck parsing |
| `pipeline.py`, `cli.py` | Stages A, B, Eval | Frozen benchmark, stage A filter, RL rows, ablation |
| `synthetic/` | | Invented personas, trait lexicon, synthetic verdicts |

## Decisions the spec left open

- **Clipping.** eps defaults to 0.01, so a maximally confident miss scores log(0.01) - log(0.5), about -3.9 nats, against a b=0.5 base rate.
- **Restatement gate.** A read is gated if its self-reported `hops == 0` *or* a single visible item entails it. Entailment is checked by running the verifier on the visible set: supported, one citation, strength at or above the threshold. Self-reported hops alone can be gamed because the policy writes that field.
- **Grounding gate.** Empty `evidenceIds` counts as ungrounded. Ungrounded reads get a fixed penalty (-1.0), not 0. With 0, citing a fake id would be a free way to dodge a likely confident miss.
- **Weak verdicts.** Verdicts below `min_verdict_strength` (0.5) are treated as unverifiable.
- **Unverifiable reads.** Reward is `(1 - u) * E_{y~critic}[R]`, where `u` is the critic's binary entropy in bits. Without a critic the reward is 0.
- **Deck reward.** `sum(read rewards) - 1.0 * mean pairwise Jaccard + 0.5 * (distinct categories / min(n_reads, 9))`. Weights are configurable. In RL the whole deck is one trajectory, so every token gets the same advantage. That is "shared across reads".
- **Base rate.** Hits over *decided* verdicts only (unverifiable is not a sample), with a Beta prior: `(hits + 2 * 0.5) / (decided + 2)`. The population is the training people's training digests, never benchmark people.
- **Undated items.** Excluded from temporal episodes by default. An optional `HIDDEN` policy uses them for verification only. They are never visible, because an undated item may postdate the cutoff.
- **Stage A.** A deck enters the verified SFT set only if at least 3 reads survive, which matches `Deck` min 3.
- **Critic target.** `nailed` = 1, `partly` = 0.5, `off` = 0, trained as soft-label logistic regression over a hashed bag of words, category, confidence, and hops.
- **Audit.** Agreement is `mean(1 - |verifier - human|)` over reads that have both a human verdict and a decided verifier verdict, so `partly` earns half credit. Agreement >= 0.75 is OK. Below that, training stops. Fewer than `min_overlap` (20) reads returns `insufficient_data`, which halts only when `require_audit` is set.
- **Bandit.** The bandit reward is critic surprise `|label - P(confirm)|`, used as a fractional Beta update per category. The card priority is critic entropy, plus 0.5 if the verifier could not decide. Only cards with confidence in [0.45, 0.8] are eligible.
- **Metrics.** Mean information gain divides by *all* reads, so gated and unverifiable reads count as zero. Accuracy and ECE use decided reads. The unverifiable rate uses reads that passed the gates. An extra ungrounded-rate column and a malformed-output count are included.
- **Benchmark.** It covers everything from the held-out people, plus the latest 20% of each training person's dated items. That window is removed from training. The benchmark is fingerprinted and re-checked before each eval, and the pipeline raises if any benchmark hidden item appears in a training episode.

## Caveats

- Undated items from training people stay in training, even though some may postdate the benchmark window.
- The audit threshold has no confidence interval. On about 50 overlapping reads, a perfect verifier facing 10% flipped and 10% `partly` human labels falls below 0.75 about 2% of the time.
- `RiverBackend` has never been run. It was checked only against the docs and the installed `river-client` 0.12.0 signatures. The notes are in `docs/working/river-notes.md`, which is gitignored and local.

## Data

`data/private/` is gitignored and belongs to another process. Nothing here reads it. Every fixture is generated by `synthetic/` from invented names and traits.
