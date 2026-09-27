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

1. Send `{ type: "join", nickname }` first. Anything else before a join gets `error` / `invalid_message`.
2. The server replies with `welcome { playerId, state }`. Store `playerId` (for example in sessionStorage).
3. To reconnect, send `join` with the stored `playerId`. Score, streak and deck are kept.
4. After every accepted action, each joined connection receives `state`. Rejected actions get an `error` sent only to the sender.

The web client needs one setting: the room host (for example `NEXT_PUBLIC_ROOM_HOST=localhost:8787`).

## Verdict export

`GET https://<host>/parties/room/<CODE>` with header `x-export-key: $EXPORT_KEY` returns that room's
`VerdictRecord`s as JSONL (`application/x-ndjson`). A missing or wrong key, or an unset `EXPORT_KEY`, returns 401.
