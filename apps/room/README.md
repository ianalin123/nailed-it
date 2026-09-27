# @nailed-it/room

Realtime room server for Nailed It. Cloudflare Workers + Durable Objects via
[`partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/partyserver).
One Durable Object per 4-letter room code.

- `src/game/`: pure reducer `(state, event) => result` plus `toPublicState`. No I/O.
- `src/session.ts`: transport-agnostic layer. Parses client messages, maps connections to players, and returns outbound sends and verdicts to persist.
- `src/server.ts`: thin partyserver adapter. It feeds the session, sends messages, and writes to Durable Object storage.

## Run locally

```sh
pnpm install            # from the repo root
cp apps/room/.env.example apps/room/.env   # then set EXPORT_KEY
pnpm --filter @nailed-it/room dev          # wrangler dev, http://localhost:8787
pnpm --filter @nailed-it/room test
pnpm --filter @nailed-it/room typecheck
```

## Connecting from the web client

WebSocket URL: `ws(s)://<host>/parties/room/<CODE>`, where `CODE` is 4 uppercase letters (`^[A-Z]{4}$`).
Any other code gets a 400. Locally that is `ws://localhost:8787/parties/room/ABCD`.

With `partysocket`:

```ts
new PartySocket({ host: ROOM_HOST, party: "room", room: "ABCD" });
```

Protocol (`@nailed-it/protocol`):

1. **Create or join.** The first message on a connection must be `join`. Anything else gets `error` / `not_joined`.
   - To create a room, the client picks a random code, connects to it and sends `{ type: "join", nickname, create: true }`.
     If the room already has (or ever had) a player, the reply is `room_exists`. Pick a new code and retry.
   - To join an existing room, send `{ type: "join", nickname }`. A room that was never created replies `room_not_found`.
2. The server replies with `welcome { playerId, reconnectToken, state }`. Store both (for example in sessionStorage).
   The token is a secret. It appears only in that welcome, never in broadcast state.
3. To reconnect, send `join` with the stored `playerId` and `token`. Score, streak and deck are kept. `create` is ignored on a
   rejoin. A missing or wrong token gets `bad_token`.
4. After every accepted action, each joined connection receives `state`. Rejected actions get an `error` sent only to the sender.

### Stage screens

A big-screen display joins with `{ type: "join", nickname, role: "stage" }`. It:

- gets `welcome` with `playerId: "stage"` and no `reconnectToken`, then every `state` broadcast;
- is never in `players`, never host, and does not count toward `MIN_PLAYERS` or `MAX_PLAYERS`;
- cannot create a room (`room_not_found` if the room does not exist yet, even with `create: true`);
- gets `stage_cannot_act` for any message other than another stage `join`. Any number of stages may watch one room.

### Game rules the server enforces

- `start` (host only) needs `MIN_PLAYERS` connected players and `MIN_DECKS` connected players with a deck. With one deck,
  that player is in the hot seat every round and everyone else guesses.
- `cardsPerPlayer` may not exceed the smallest submitted deck (`not_enough_decks`). `players[].deckSize` shows each deck's size.
- The hot seat cannot guess on their own card (`hot_seat_cannot_guess`).
- During voting, `round` shows only who voted, plus `yourGuess` for the viewing player. Truth, everyone's guesses, the
  reader's confidence, the reasoning `chain` and points appear only in the reveal phase. Stages get no `yourGuess`.
- `invalid_message` is reserved for malformed or off-protocol input.

The web client needs one setting: the room host (for example `NEXT_PUBLIC_ROOM_HOST=localhost:8787`).

## Verdict export

`GET https://<host>/parties/room/<CODE>` with header `x-export-key: $EXPORT_KEY` returns that room's
`VerdictRecord`s as JSONL (`application/x-ndjson`). A missing or wrong key, or an unset `EXPORT_KEY`, returns 401.
