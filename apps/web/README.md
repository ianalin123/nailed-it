# @nailed-it/web

The phone client for Nailed It: create or join a room, submit a deck, guess, reveal, see the leaderboard.
Next.js App Router, Tailwind v4, `partysocket`. The shared contract is `@nailed-it/protocol`, and the
server's `RoomState` is the only source of truth the UI renders from.

## Run

```sh
cp .env.example .env.local        # then set NEXT_PUBLIC_ROOM_HOST
pnpm --filter @nailed-it/web dev
```

No server yet? Play against simulated players in the browser:

```sh
pnpm --filter @nailed-it/web dev:mock
```

The mock makes you host, adds Juno, Ravi and Moss (Moss never submits a deck), and has the bots guess
and reveal on timers, so every screen is reachable from one tab.

## Env

| Var | Meaning |
|---|---|
| `NEXT_PUBLIC_ROOM_HOST` | PartyKit host without protocol, e.g. `localhost:8787` |
| `NEXT_PUBLIC_ROOM_PARTY` | Party name if the room server isn't the `main` party. Optional. |
| `NEXT_PUBLIC_ROOM_MOCK` | `1` to use the in-browser mock instead of a server |

## Layout

- `src/lib/game/` pure rules for the UI: selectors (who can guess, why Start is disabled), room codes, demo deck
- `src/lib/room/` connection layer: `RoomTransport` interface, PartyKit and mock transports, message decoding, session reducer, `useRoom`
- `src/lib/room/mock/` in-browser game engine used by the mock transport
- `src/components/room/` one view per screen, picked by `screenFor(state)`

## Checks

```sh
pnpm --filter @nailed-it/web test
pnpm --filter @nailed-it/web typecheck
pnpm --filter @nailed-it/web build     # or build:webpack where Turbopack's PostCSS worker can't open a local port
```
