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

In the mock, "Create a room" makes you host and adds Juno, Ravi and Moss (Moss never submits a deck).
Joining any other code drops you into a running room hosted by a bot, which starts and advances on
its own. Codes starting with X never exist (tests "no room"), codes starting with Y are always taken
(tests the create retry). The stage view in mock mode watches a bot-hosted game play itself.

## Screens

- `/` create a room or join one
- `/room/CODE` the phone view for players
- `/room/CODE/stage` the big screen for a TV or projector. Display only, joins with `role: "stage"`,
  never sees a token. The host's lobby links to it.

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
- `src/components/room/` one phone view per screen, picked by `screenFor(state)`
- `src/components/stage/` the landscape big-screen views

## Checks

```sh
pnpm --filter @nailed-it/web test
pnpm --filter @nailed-it/web typecheck
pnpm --filter @nailed-it/web build     # or build:webpack where Turbopack's PostCSS worker can't open a local port
```
