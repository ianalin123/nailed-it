---
name: read
description: Scan this machine for evidence about how the player works, thinks, and relates to people, build an owner-approved deck of specific reads about them, and submit it to their Nailed It game room.
argument-hint: [ROOM_CODE]
arguments: [room_code]
disable-model-invocation: true
---

You are running the Nailed It reader for the person sitting at this keyboard
(the "owner"). Room code: `$room_code`.

This is a five-phase pipeline. Do not skip a phase or reorder them. **Nothing
leaves this machine before Phase 3 finishes.** Phases 1-2 only read local
files; Phase 3 is the one and only place the owner reviews raw evidence
before any of it can travel anywhere; Phases 4-5 build and send only the
approved, derived `Deck`.

Scripts referenced below live at `${CLAUDE_PLUGIN_ROOT}/scripts/`. Run them
from the plugin root so their local dependencies resolve:

```
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm exec tsx scripts/<name>.ts <args>
```

## Phase 1: Plan

Before touching any file, write a short research plan as plain text (not a
file) covering:

- Which sources you'll check, from what's available on this machine:
  Claude Code session history and memory files under `~/.claude/projects`,
  git history of the owner's repos, project folders they work in, and any
  connected note/calendar tools (e.g. an MCP server for notes, calendar, or
  chat that's available in this session).
- What you're looking for in each source: who this person is, how they
  work, what they care about, their taste, and their social world. Concretely
  that means things like: recurring technical decisions and the reasoning
  behind them, what kind of problems they gravitate to versus avoid, naming
  and code-style habits, what projects they return to versus abandon, what
  they argue for in commit messages or notes, who they collaborate with and
  how, humor, recurring phrases, aesthetic preferences.
- What you will explicitly NOT collect: anything that looks like money,
  contracts or legal terms, health information, credentials, other people's
  contact details, or specific facts about named third parties. Skip these
  at the source — don't copy them into evidence items and rely on Phase 3 to
  catch them. Phase 3's automated screen is a backstop, not the plan.

Show this plan to the owner in one short message before you start gathering.
You do not need their sign-off to proceed (this is their own machine, their
own data, and Phase 3 is the real gate) — just tell them what you're about to
look at, so nothing is a surprise.

## Phase 2: Gather

Work through your plan. For each source, look for specific, dated-when-possible
signal, not vibes. Prefer many small observations over few broad ones — you
will curate and infer from these later, in Phase 4.

As you go, write short evidence notes for yourself (in your own working
memory or scratch file, not yet the digest — the digest is built in Phase 3).
For each note, capture:

- what you observed (specific, not generic — "always splits the diff into a
  refactor commit and a behavior commit" beats "writes clean commits")
- which source it came from (map to one of: `claude_sessions`,
  `claude_memory`, `git_history`, `project_files`, `meeting_notes`,
  `calendar`, `email`, `other`)
- a date if you can attach one

Do not include: money amounts, contract or legal terms, health information,
credentials (API keys, passwords, tokens), anyone's contact details (email,
phone), or specific claims about a named third party (a coworker, partner,
friend — reads must be about the owner, not about people around them). If
you're unsure whether something crosses a line, leave it out; you can always
gather more later, but you can't un-surface something to the owner.

Aim for enough raw material to support around 20 final reads after Phase 4's
inference and curation — that usually means 40-80 evidence notes, since not
every note survives into a read and reads should mix categories.

## Phase 3: Build the digest and get owner approval (strict gate)

1. Turn your Phase 2 notes into `EvidenceItem` objects (`id`, `source`,
   `text` under 600 chars, `observedAt` when you have a date) and assemble
   them into an `EvidenceDigest`:
   `{ protocolVersion: 1, digestId, displayName, createdAt, items }`.
   Generate `digestId` yourself (e.g. a short random string); `displayName`
   is what the owner wants shown in the room, ask if unclear.

2. Write the digest to a local file (e.g. in your working directory, not
   inside this plugin) and run the flagger against it:

   ```
   cd "${CLAUDE_PLUGIN_ROOT}" && pnpm exec tsx scripts/redact.ts <path-to-digest.json>
   ```

   This flags every item that contains a money amount, an email address, a
   phone number, a URL with a token in it, an API-key-looking string, or
   health-related language. It reports every item, flagged or not — nothing
   is dropped for you.

3. On top of the script's output, re-read every item yourself for what
   regexes can't catch: contract or legal terms, and anything that names or
   clearly identifies a third party. Flag those too, with your own reason.

4. Show the owner the full digest **grouped by source**, with every flagged
   item marked and its reason(s) shown. State plainly: "Items with flags are
   excluded by default. Tell me which ones to add back, one at a time, or
   `all` if you're sure." Exclude every flagged item unless the owner
   explicitly opts it back in. Never bulk-restore flagged items on the
   owner's behalf.

5. Also let the owner drop any unflagged item they just don't want included,
   for any reason or none.

6. Do not proceed to Phase 4 until the owner has responded to every flagged
   item and confirmed they're done reviewing. Produce the final
   `EvidenceDigest` from what survives — this is the only artifact that ever
   leaves the machine, and only after this step.

## Phase 4: Write the deck

From the approved digest, write a `Deck`: `{ protocolVersion: 1, digestId,
reads }` with around 20 `Read` objects. Each `Read` is `{ id, text, category,
confidence, evidenceIds, hops, modelVersion }`. Hold yourself to these rules
hard:

- **Inferred, not restated.** `hops` is your honest inferential distance from
  the evidence: `0` means the read just repeats an evidence item in other
  words — don't write those. Every read in the deck should be `hops >= 1`.
  Push for `hops >= 2` where you can: combine two or more evidence items, or
  reason one step past what's directly observed ("reviews her own diffs
  before opening a PR" + "commit messages explain why, not what" → "she
  treats the commit message as the first draft of the PR description").
- **Specific, not generic.** Avoid statements true of nearly everyone
  ("you care about doing good work"). If a read would land the same way for
  most people you know, cut it or sharpen it until it's specific to this
  person's actual evidence.
- **Honest confidence.** `confidence` is your real probability the owner
  confirms this read, in [0, 1]. A wild guess should say so (~0.4-0.5), not
  borrow the confidence of your best read.
- **Grounded.** `evidenceIds` (max 12) must be real ids from the approved
  digest. Don't cite an item you didn't use.
- **Mixed categories.** Spread reads across the available categories
  (`work_style`, `technical_identity`, `intellectual_signature`,
  `ambition_psychology`, `taste_aesthetics`, `people_social`,
  `life_logistics`, `relationship_with_ai`, `risky_read`) rather than
  clustering in one or two.
- **Kind.** Every read must be safe to say in front of friends. Nothing
  humiliating, nothing about health, money, or named third parties — even if
  the (already-approved) evidence technically supports it. The evidence gate
  in Phase 3 controls what data exists; this is a second, independent check
  on what you choose to say about it.
- `modelVersion` is always `"teacher-v0"`.

Validate before showing it to anyone:

```
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm exec tsx scripts/validate.ts <path-to-deck.json>
```

Fix every reported error and re-run until it prints `valid deck`.

## Phase 5: Owner approves the deck, then submit

1. Show the owner the full deck, read by read, with category and confidence.
   Let them drop any read, for any reason. Re-validate after removing any
   (the schema requires at least 3 reads left).

2. Ask the owner for their **upload code** for this room. The web lobby
   shows it on their own phone after they join. It has two parts: a player
   id and a secret token. The token proves the deck is theirs, so treat it
   like a password: do not print it back, write it to a file, or include it
   in any summary.

3. Submit, passing the token through the environment so it stays out of the
   process list:

   ```
   cd "${CLAUDE_PLUGIN_ROOT}" && NAILED_IT_TOKEN=<TOKEN> pnpm exec tsx scripts/submit-deck.ts \
     --room $room_code \
     --player-id <PLAYER_ID> \
     --deck <path-to-deck.json> \
     --host <ROOM_HOST>
   ```

   `--host` can be omitted if `NAILED_IT_ROOM_HOST` is set in the
   environment. The script validates the deck again on its own before
   sending anything, waits for the room's `state` or `error` response, and
   exits non-zero on any failure (validation, server error, or timeout). A `bad_token` error means the
   upload code was mistyped or belongs to another room. If
   it fails, report the exact message back to the owner rather than retrying
   blindly.

4. On success, tell the owner their deck is in the room and they're ready to
   play.
