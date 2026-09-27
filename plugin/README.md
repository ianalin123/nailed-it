# @nailed-it/plugin

Claude Code plugin for [Nailed It](../docs/working/spec.md): a live
multiplayer party game where a model reads each player from data on their
own machine, and everyone guesses whether it got them right.

## What's here

- `skills/read/SKILL.md` — the `/nailed-it:read <ROOM_CODE>` command. Plans a
  local scan, gathers evidence, gets strict owner approval before anything
  leaves the machine, writes a deck of `Read`s, gets owner approval on the
  deck, and submits it to a room.
- `scripts/redact.ts` — pure functions that flag `EvidenceItem` text
  containing money amounts, email addresses, phone numbers, URLs with
  tokens, API-key-like strings, or health-related language. Never drops
  anything; always returns the flags so a human can decide.
- `scripts/validate.ts` — validates a digest or deck JSON file against the
  `@nailed-it/protocol` Zod schemas and prints precise per-field errors.
- `scripts/submit-deck.ts` — connects to a room over WebSocket as an
  existing player: rejoins with that player's reconnect token, then sends
  `submit_deck`.

Each script is both an importable module of pure/typed functions and a thin
CLI you can run directly.

## Data boundary

This plugin only ever sends an `EvidenceDigest` (after owner approval, item
by item) or a `Deck` derived from it (after a second owner approval). Raw
evidence text, once excluded by the owner in Phase 3 of the skill, is never
sent anywhere. See `docs/working/spec.md` § Data boundary for the full
contract this plugin must honor.

## Upload code handoff

The room server ties a deck to whichever player the connection joined as, and
rejoining as an existing player requires that player's secret reconnect token.
So the plugin needs two values from the web client: the player id and the
token.

After a player joins, the lobby shows an upload code on that player's own
device only. The owner gives it to the `read` skill in Phase 5.
`submit-deck.ts` sends `join` with the id and token, waits for `welcome`, then
sends `submit_deck`.

The token is a secret. Pass it as `NAILED_IT_TOKEN` rather than `--token`, and
never show it on a shared screen.

## Development

```fish
cd /Users/ianalin/nailed-it
pnpm add --filter @nailed-it/plugin <pkg>   # add a dependency
pnpm --filter @nailed-it/plugin test
pnpm --filter @nailed-it/plugin typecheck
claude plugin validate ./plugin --strict
```

### Running a script directly

```fish
cd /Users/ianalin/nailed-it/plugin
pnpm exec tsx scripts/validate.ts path/to/digest.json
pnpm exec tsx scripts/redact.ts path/to/digest.json
env NAILED_IT_TOKEN=t1 pnpm exec tsx scripts/submit-deck.ts --room ABCD --player-id p1 --deck path/to/deck.json --host localhost:8787
```

`submit-deck.ts` reads `--host` from `NAILED_IT_ROOM_HOST` if `--host` is
omitted, and `--party` from `NAILED_IT_ROOM_PARTY` (default `"room"`, see the
contract-change note in the coordinator report — the actual PartyServer
binding name isn't fixed yet).
