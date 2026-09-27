import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const ROOM_CODE_LENGTH = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;
export const MAX_READ_LENGTH = 240;

export const SourceKind = z.enum([
  "claude_sessions",
  "claude_memory",
  "git_history",
  "project_files",
  "meeting_notes",
  "calendar",
  "email",
  "other",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const ReadCategory = z.enum([
  "work_style",
  "technical_identity",
  "intellectual_signature",
  "ambition_psychology",
  "taste_aesthetics",
  "people_social",
  "life_logistics",
  "relationship_with_ai",
  "risky_read",
]);
export type ReadCategory = z.infer<typeof ReadCategory>;

export const EvidenceItem = z.object({
  id: z.string().min(1),
  source: SourceKind,
  text: z.string().min(1).max(600),
  observedAt: z.string().datetime().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

// The only artifact that leaves a player's machine. Every item is owner-approved.
export const EvidenceDigest = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  digestId: z.string().min(1),
  displayName: z.string().min(1).max(40),
  createdAt: z.string().datetime(),
  items: z.array(EvidenceItem).min(1).max(400),
});
export type EvidenceDigest = z.infer<typeof EvidenceDigest>;

export const Read = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_READ_LENGTH),
  category: ReadCategory,
  // The reader's own probability that the owner will confirm this read.
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()).max(12),
  // Inferential distance from the evidence. 0 means it restates an evidence item.
  hops: z.number().int().min(0).max(5),
  modelVersion: z.string().min(1),
});
export type Read = z.infer<typeof Read>;

export const Deck = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  digestId: z.string().min(1),
  reads: z.array(Read).min(3).max(30),
});
export type Deck = z.infer<typeof Deck>;

export const Guess = z.enum(["nailed", "off"]);
export type Guess = z.infer<typeof Guess>;

export const Truth = z.enum(["nailed", "partly", "off"]);
export type Truth = z.infer<typeof Truth>;

export const Player = z.object({
  id: z.string().min(1),
  nickname: z.string().min(1).max(20),
  isHost: z.boolean(),
  connected: z.boolean(),
  hasDeck: z.boolean(),
  score: z.number().int(),
  streak: z.number().int().min(0),
});
export type Player = z.infer<typeof Player>;

export const RoundPhase = z.enum(["voting", "reveal"]);
export type RoundPhase = z.infer<typeof RoundPhase>;

export const Round = z.object({
  index: z.number().int().min(0),
  total: z.number().int().min(1),
  hotSeatPlayerId: z.string(),
  read: Read.pick({ id: true, text: true, category: true }),
  phase: RoundPhase,
  votedPlayerIds: z.array(z.string()),
  // Present only in the reveal phase.
  truth: Truth.optional(),
  guesses: z.record(z.string(), Guess).optional(),
  readerConfidence: z.number().min(0).max(1).optional(),
  pointsAwarded: z.record(z.string(), z.number().int()).optional(),
});
export type Round = z.infer<typeof Round>;

export const RoomStatus = z.enum(["lobby", "playing", "finished"]);
export type RoomStatus = z.infer<typeof RoomStatus>;

export const RoomState = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  code: z.string().length(ROOM_CODE_LENGTH),
  status: RoomStatus,
  players: z.array(Player),
  round: Round.optional(),
  // How often the reader was right this game, shown on the final screen.
  readerAccuracy: z.number().min(0).max(1).optional(),
});
export type RoomState = z.infer<typeof RoomState>;

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    nickname: z.string().min(1).max(20),
    // Rejoining as an existing player requires the token from that player's welcome.
    playerId: z.string().optional(),
    token: z.string().optional(),
  }),
  z.object({ type: z.literal("submit_deck"), deck: Deck }),
  z.object({ type: z.literal("start"), cardsPerPlayer: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal("guess"), readId: z.string(), guess: Guess }),
  z.object({ type: z.literal("reveal"), readId: z.string(), truth: Truth }),
  z.object({ type: z.literal("next") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ErrorCode = z.enum([
  "invalid_message",
  "room_full",
  "not_host",
  "not_hot_seat",
  "wrong_phase",
  "not_enough_players",
  "not_enough_decks",
  "unknown_read",
  "bad_token",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerMessage = z.discriminatedUnion("type", [
  // reconnectToken is a secret. It is sent only here, to the joining connection, never in state.
  z.object({ type: z.literal("welcome"), playerId: z.string(), reconnectToken: z.string().optional(), state: RoomState }),
  z.object({ type: z.literal("state"), state: RoomState }),
  z.object({ type: z.literal("error"), code: ErrorCode, message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// One row of training signal. Written as JSONL by the room server, read by training/.
// Contains the read text and outcome, never the evidence itself.
export const VerdictRecord = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomCode: z.string(),
  recordedAt: z.string().datetime(),
  digestId: z.string(),
  read: Read,
  truth: Truth,
  guessCounts: z.object({ nailed: z.number().int().min(0), off: z.number().int().min(0) }),
});
export type VerdictRecord = z.infer<typeof VerdictRecord>;

export const parseClientMessage = (raw: unknown) => ClientMessage.safeParse(raw);
export const parseServerMessage = (raw: unknown) => ServerMessage.safeParse(raw);
