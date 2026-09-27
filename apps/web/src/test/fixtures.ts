import { PROTOCOL_VERSION, type Player, type RoomState, type Round } from "@nailed-it/protocol";

export const makePlayer = (overrides: Partial<Player> & Pick<Player, "id">): Player => ({
  nickname: overrides.id.toUpperCase(),
  isHost: false,
  connected: true,
  hasDeck: false,
  score: 0,
  streak: 0,
  ...overrides,
});

export const makeRound = (overrides: Partial<Round> = {}): Round => ({
  index: 0,
  total: 4,
  hotSeatPlayerId: "b",
  read: { id: "r1", text: "You rename files like final_v3_REAL.pdf.", category: "work_style" },
  phase: "voting",
  votedPlayerIds: [],
  ...overrides,
});

export const makeState = (overrides: Partial<RoomState> = {}): RoomState => ({
  protocolVersion: PROTOCOL_VERSION,
  code: "ABCD",
  status: "lobby",
  players: [
    makePlayer({ id: "a", nickname: "Ada", isHost: true, hasDeck: true }),
    makePlayer({ id: "b", nickname: "Bo", hasDeck: true }),
    makePlayer({ id: "c", nickname: "Cy" }),
  ],
  ...overrides,
});
