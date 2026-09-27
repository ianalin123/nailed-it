# Memorable and the `/nailed-it:read` research procedure

[Memorable](https://www.memorable.sh/) ("procedural memory for AI agents")
turns an agent's successful tool-call history into a reusable, retrievable
workflow. This doc maps the `read` skill's Phase 1 (plan) and Phase 2
(gather) onto Memorable's model concretely, using only what its public site
and docs state. Anything not stated there is marked **UNCONFIRMED**.

This doc is research only. Nothing here was run: no `memorable login`,
`install-hooks`, `enable`, or CLI install, per the task's hard limit — those
change the owner's account and machine and are the owner's call.

## What Memorable's own docs say about this exact use case

Memorable's use-case page lists **Research Agents** as one of six categories,
described as: "Investigation processes are preserved and reapplied across
new reports," with the specific claim "**Gather steps stored once, reused on
the next report.**"
(Source: https://www.memorable.sh/use-case)

That is close to a literal description of Phase 1→2 of `read`: plan which
sources to check (`~/.claude/projects`, git history, project files, notes),
then gather from them. A second player's `/nailed-it:read` run, or a re-run
for the same player after new evidence accumulates, is Memorable's "next
report."

## The pipeline, in Memorable's own terms

Memorable describes a four-layer pipeline
(source: https://www.memorable.sh/ and https://www.memorable.sh/doc):

1. **Traces** — raw records of an agent session: prompts, tool calls, file
   reads, commands executed.
2. **Workflow synthesis** — an "Extraction API" converts a tool-call trace
   into a structured procedure. The doc page shows the response shape:

   ```json
   {
     "draft": {
       "title": "string",
       "schema_version": "1.0.0",
       "steps": [
         { "seq": 0, "action": "string (tool name)", "activity_class": "execute", "command": "string", "repeat_count": 0 }
       ],
       "postconditions": ["string array"],
       "embedding": [],
       "embedding_model": ""
     },
     "request_id": "string"
   }
   ```
   (Source: https://www.memorable.sh/doc)

3. **Graph assembly** — workflows are connected by shared steps/prefixes so
   new procedures can compose from stored ones.
   (Source: https://www.memorable.sh/)

4. **Retrieval** — `memorable recall "<task description>"` matches "exact,
   then lexical, then a vector. A reworded ask still lands." The doc page
   shows lexical hit rate 0.86 and semantic hit rate 0.79 in its example.
   (Source: https://www.memorable.sh/doc)

## Concretely, how this would capture the `read` procedure

1. **Enable it, once, on the owner's own account** (not done here):
   ```
   npx memorable-cli@latest login
   memorable enable
   ```
   (Source: https://www.memorable.sh/doc, "Quickstart")

2. **Wire it into Claude Code sessions**:
   ```
   memorable install-hooks
   ```
   This is described only as enabling "recall on every new prompt"
   (source: https://www.memorable.sh/, CLI summary) and, on the use-case
   page, as "Hooks and consent are written for you" during agent setup
   (source: https://www.memorable.sh/use-case). **UNCONFIRMED**: which
   Claude Code hook events it registers (e.g. `SessionStart`,
   `UserPromptSubmit`, `Stop`) and whether it writes to a plugin-style
   `hooks/hooks.json` or the user's `settings.json` — the public pages don't
   show the generated hook config.

3. **Capture a trace of a `/nailed-it:read` run.** Either automatically
   while enabled ("record when it finishes" per
   https://www.memorable.sh/doc), or explicitly:
   ```
   memorable record --session
   memorable ingest trace.json
   ```
   The trace would be the sequence of tool calls Phase 1-2 actually make:
   the `Read`/`Grep`/`Bash` calls the agent used to walk
   `~/.claude/projects`, run `git log`, and read project files — not the
   evidence text itself, which only exists after Phase 2 writes it into the
   digest. **UNCONFIRMED, and load-bearing**: Memorable's own privacy line
   is "only sanitized prompts and tool arguments leave the device" (source:
   https://www.memorable.sh/). Tool *arguments* for a Phase 2 scan are
   themselves sensitive — file paths under a person's home directory, grep
   patterns, git log output. Whether "sanitized" here means those arguments
   are stripped, redacted, or sent as-is to a hosted Extraction API is not
   stated anywhere I could confirm. Before ever enabling Memorable for this
   plugin, that question needs a real answer, because Phase 2 runs entirely
   *before* the owner-approval gate in Phase 3 — the same gate this spec's
   Data boundary rule 1 ("Raw data never leaves the machine") depends on.
   Turning on trace capture for `read` would need to either (a) confirm
   extraction happens locally with no network call, or (b) scope hooked
   capture to start only after Phase 3, never during Phase 1-2.

4. **The stored procedure becomes the reusable "gather evidence for a
   Nailed It read" workflow.** Storage location is the owner's choice:
   ```
   memorable init            # this machine (default)
   memorable init gbrain <database>
   memorable init qm <postgres-connection>
   ```
   (Source: https://www.memorable.sh/, "Keep the store yours" /
   https://www.memorable.sh/doc)

5. **On the next `/nailed-it:read` run** (a new player, or the same player
   later), recall would surface it before Phase 1 re-derives a plan from
   scratch:
   ```
   memorable recall "scan this machine for evidence about how someone works, thinks, and relates to people"
   memorable show <slug>
   ```
   `show` is described as displaying "steps, files touched, and verification
   commands" (source: https://www.memorable.sh/). In practice that would let
   the agent skip re-discovering *which* sources exist and *how* to query
   them (e.g. the exact `grep`/`git log` incantations that worked last time)
   and go straight to gathering, while still applying Phase 2's exclusion
   rules and Phase 3's approval gate fresh each time — the workflow should
   only ever replay *how to look*, never *what was found*, since the latter
   is one specific person's approved-or-not evidence.

## CLI commands referenced above, collected

From https://www.memorable.sh/ and https://www.memorable.sh/doc:

```
npx memorable-cli@latest login
memorable enable
memorable disable
memorable status
memorable install-hooks
memorable init [gbrain <database> | qm <postgres-connection>]
memorable record [--session]
memorable ingest <trace.json | ->
memorable recall "<task description>"
memorable recall [--single | --chain]
memorable chain "<task>" [--render] [--json]
memorable show <slug>
memorable list [--all] [--json]
memorable prune <slug>... | --stale | --superseded [--dry-run]
memorable doctor
memorable mcp
claude mcp add memorable -- memorable mcp
memorable agents-md >> AGENTS.md
memorable forget
```

## Confirmed vs UNCONFIRMED, summarized

**Confirmed** (stated on memorable.sh's own pages):
- The trace → extraction → graph → recall pipeline and its three-tier
  match order (exact, lexical, vector).
- That "Research Agents" is a named use case matching a plan-then-gather
  procedure, described as "gather steps stored once, reused on the next
  report."
- The CLI command list above, and that storage can be local-only, gbrain,
  or QM Postgres.
- The procedure/workflow JSON shape (`title`, `steps`, `postconditions`,
  `embedding`).

**UNCONFIRMED**:
- Exactly what `install-hooks` writes into a Claude Code project (which
  hook events, which file).
- Whether trace extraction/synthesis happens locally or via a hosted API
  call, and precisely what counts as "sanitized" in tool arguments before
  they leave the device. This is the one that matters most for `read`,
  since Phase 2 gathers before the owner has approved anything.
- Whether a stored workflow can be scoped to "steps only, never captured
  values" — needed so a recalled `read` procedure never leaks a specific
  person's evidence into another player's run.
- Pricing/plan limits, team sharing of stored workflows, and retention.

## Recommendation

Don't wire Memorable into `read`'s Phase 1-2 until the extraction-locality
question above has a confirmed answer from the owner's own account (e.g. by
inspecting what `memorable record` actually sends, with network traffic
observed, before trusting the "sanitized" claim) or from Memorable directly.
If confirmed local-only, it's a good fit for exactly the part of this skill
that's genuinely repetitive across players: *how* to search, never *what*
was found.
