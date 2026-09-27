import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type VerdictRecord,
} from "@nailed-it/protocol";
import { toPublicState } from "./game/public-state";
import { createRoom, reduce, roomExists } from "./game/reducer";
import type { Effect, GameEvent, InternalState, RandomSource } from "./game/types";

export interface Session {
  readonly state: InternalState;
  readonly playerByConnection: ReadonlyMap<string, string>;
  readonly stageConnections: ReadonlySet<string>;
  readonly tokenByPlayer: ReadonlyMap<string, string>;
}

// Sent as welcome.playerId to stage screens, which are never players.
export const STAGE_VIEWER_ID = "stage";

export interface SessionDeps {
  readonly newPlayerId: () => string;
  readonly newToken: () => string;
  readonly random: RandomSource;
  readonly now: () => string;
}

export type Outbound =
  | { readonly kind: "send"; readonly connectionId: string; readonly message: ServerMessage }
  | { readonly kind: "persist_verdict"; readonly sequence: number; readonly record: VerdictRecord };

export interface SessionStep {
  readonly session: Session;
  readonly outbound: readonly Outbound[];
}

export const createSession = (
  code: string,
  state: InternalState = createRoom(code),
  tokenByPlayer: ReadonlyMap<string, string> = new Map(),
): Session => ({
  state,
  playerByConnection: new Map(),
  stageConnections: new Set(),
  tokenByPlayer,
});

const errorTo = (connectionId: string, code: ErrorCode, message: string): SessionStep["outbound"] => [
  { kind: "send", connectionId, message: { type: "error", code, message } },
];

const unchanged = (session: Session, outbound: readonly Outbound[]): SessionStep => ({ session, outbound });

type Viewer = readonly [connectionId: string, playerId: string | undefined];

const viewers = (session: Session): Viewer[] => [
  ...session.playerByConnection,
  ...[...session.stageConnections].map((connectionId): Viewer => [connectionId, undefined]),
];

const stateBroadcast = (session: Session, exclude: ReadonlySet<string> = new Set()): Outbound[] =>
  viewers(session)
    .filter(([connectionId]) => !exclude.has(connectionId))
    .map(([connectionId, playerId]) => ({
      kind: "send",
      connectionId,
      message: { type: "state", state: toPublicState(session.state, playerId) },
    }));

const verdictOutbound = (state: InternalState, effects: readonly Effect[]): Outbound[] =>
  effects.map((effect) => ({
    kind: "persist_verdict",
    sequence: state.outcomes.length - 1,
    record: effect.record,
  }));

const parseRaw = (raw: string): ClientMessage | string => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return `Message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const parsed = parseClientMessage(json);
  return parsed.success ? parsed.data : `Message does not match the protocol: ${parsed.error.message}`;
};

const toGameEvent = (message: Exclude<ClientMessage, { type: "join" }>, playerId: string, deps: SessionDeps): GameEvent => {
  switch (message.type) {
    case "submit_deck":
      return { type: "submit_deck", playerId, deck: message.deck };
    case "start":
      return { type: "start", playerId, cardsPerPlayer: message.cardsPerPlayer, random: deps.random };
    case "guess":
      return { type: "guess", playerId, readId: message.readId, guess: message.guess };
    case "reveal":
      return { type: "reveal", playerId, readId: message.readId, truth: message.truth, recordedAt: deps.now() };
    case "next":
      return { type: "next", playerId };
  }
};

const applyEvent = (session: Session, connectionId: string, event: GameEvent): SessionStep => {
  const result = reduce(session.state, event);
  if (!result.ok) return unchanged(session, errorTo(connectionId, result.error.code, result.error.message));
  const next: Session = { ...session, state: result.state };
  return { session: next, outbound: [...verdictOutbound(result.state, result.effects), ...stateBroadcast(next)] };
};

const sameSecret = (expected: string, given: string): boolean => {
  if (expected.length !== given.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return difference === 0;
};

type JoinMessage = Extract<ClientMessage, { type: "join" }>;

type Claim =
  | { readonly ok: true; readonly playerId: string; readonly token: string; readonly isNew: boolean }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

const BAD_TOKEN = "Rejoining as an existing player requires that player's reconnect token.";

const resolveClaim = (
  session: Session,
  connectionId: string,
  message: JoinMessage,
  deps: SessionDeps,
): Claim => {
  const bound = session.playerByConnection.get(connectionId);
  if (bound !== undefined) {
    if (message.playerId !== undefined && message.playerId !== bound) {
      return { ok: false, code: "invalid_message", message: "This connection already joined as another player." };
    }
    const token = session.tokenByPlayer.get(bound);
    if (token === undefined) throw new Error(`Bound player ${bound} has no reconnect token`);
    return { ok: true, playerId: bound, token, isNew: false };
  }
  if (message.playerId === undefined) {
    return { ok: true, playerId: deps.newPlayerId(), token: deps.newToken(), isNew: true };
  }
  const expected = session.tokenByPlayer.get(message.playerId);
  if (expected === undefined || message.token === undefined || !sameSecret(expected, message.token)) {
    return { ok: false, code: "bad_token", message: BAD_TOKEN };
  }
  return { ok: true, playerId: message.playerId, token: expected, isNew: false };
};

const STAGE_CANNOT_ACT = "A stage screen only displays the room. Open a new connection to play.";

const handleStageJoin = (session: Session, connectionId: string): SessionStep => {
  if (session.playerByConnection.has(connectionId)) {
    return unchanged(session, errorTo(connectionId, "invalid_message", "This connection already joined as a player."));
  }
  if (!roomExists(session.state)) {
    return unchanged(session, errorTo(connectionId, "room_not_found", `Room ${session.state.code} does not exist.`));
  }
  const next: Session = { ...session, stageConnections: new Set(session.stageConnections).add(connectionId) };
  const welcome: Outbound = {
    kind: "send",
    connectionId,
    message: { type: "welcome", playerId: STAGE_VIEWER_ID, state: toPublicState(session.state) },
  };
  return { session: next, outbound: [welcome] };
};

const handlePlayerJoin = (session: Session, connectionId: string, message: JoinMessage, deps: SessionDeps): SessionStep => {
  const claim = resolveClaim(session, connectionId, message, deps);
  if (!claim.ok) return unchanged(session, errorTo(connectionId, claim.code, claim.message));
  const { playerId, token } = claim;
  const result = reduce(session.state, { type: "join", playerId, nickname: message.nickname, create: message.create === true });
  if (!result.ok) return unchanged(session, errorTo(connectionId, result.error.code, result.error.message));
  const next: Session = {
    ...session,
    state: result.state,
    playerByConnection: new Map(session.playerByConnection).set(connectionId, playerId),
    tokenByPlayer: claim.isNew ? new Map(session.tokenByPlayer).set(playerId, token) : session.tokenByPlayer,
  };
  const welcome: Outbound = {
    kind: "send",
    connectionId,
    message: { type: "welcome", playerId, reconnectToken: token, state: toPublicState(result.state, playerId) },
  };
  return { session: next, outbound: [welcome, ...stateBroadcast(next, new Set([connectionId]))] };
};

const isStageJoin = (message: ClientMessage): boolean => message.type === "join" && message.role === "stage";

const handleStageMessage = (session: Session, connectionId: string, message: ClientMessage): SessionStep =>
  isStageJoin(message)
    ? handleStageJoin(session, connectionId)
    : unchanged(session, errorTo(connectionId, "stage_cannot_act", STAGE_CANNOT_ACT));

export const handleMessage = (session: Session, connectionId: string, raw: string, deps: SessionDeps): SessionStep => {
  const message = parseRaw(raw);
  if (typeof message === "string") return unchanged(session, errorTo(connectionId, "invalid_message", message));
  if (session.stageConnections.has(connectionId)) return handleStageMessage(session, connectionId, message);
  if (message.type === "join") {
    return message.role === "stage"
      ? handleStageJoin(session, connectionId)
      : handlePlayerJoin(session, connectionId, message, deps);
  }
  const playerId = session.playerByConnection.get(connectionId);
  if (playerId === undefined) {
    return unchanged(session, errorTo(connectionId, "not_joined", "Send a join message first."));
  }
  return applyEvent(session, connectionId, toGameEvent(message, playerId, deps));
};

const detachStage = (session: Session, connectionId: string): SessionStep => {
  const remaining = new Set(session.stageConnections);
  remaining.delete(connectionId);
  return unchanged({ ...session, stageConnections: remaining }, []);
};

export const handleClose = (session: Session, connectionId: string): SessionStep => {
  if (session.stageConnections.has(connectionId)) return detachStage(session, connectionId);
  const playerId = session.playerByConnection.get(connectionId);
  if (playerId === undefined) return unchanged(session, []);
  const remaining = new Map(session.playerByConnection);
  remaining.delete(connectionId);
  const detached: Session = { ...session, playerByConnection: remaining };
  const stillConnected = [...remaining.values()].includes(playerId);
  if (stillConnected) return unchanged(detached, []);
  const result = reduce(detached.state, { type: "disconnect", playerId });
  if (!result.ok) throw new Error(`Disconnect of bound player ${playerId} was rejected: ${result.error.message}`);
  const next: Session = { ...detached, state: result.state };
  return { session: next, outbound: stateBroadcast(next) };
};

export const disconnectEveryone = (state: InternalState): InternalState =>
  state.players
    .filter((p) => p.connected)
    .reduce((current, player) => {
      const result = reduce(current, { type: "disconnect", playerId: player.id });
      if (!result.ok) throw new Error(`Disconnect of stored player ${player.id} was rejected: ${result.error.message}`);
      return result.state;
    }, state);
