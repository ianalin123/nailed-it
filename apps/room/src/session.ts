import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type VerdictRecord,
} from "@nailed-it/protocol";
import { toPublicState } from "./game/public-state";
import { createRoom, reduce } from "./game/reducer";
import type { Effect, GameEvent, InternalState, RandomSource } from "./game/types";

export interface Session {
  readonly state: InternalState;
  readonly playerByConnection: ReadonlyMap<string, string>;
}

export interface SessionDeps {
  readonly newPlayerId: () => string;
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

export const createSession = (code: string, state: InternalState = createRoom(code)): Session => ({
  state,
  playerByConnection: new Map(),
});

const errorTo = (connectionId: string, code: ErrorCode, message: string): SessionStep["outbound"] => [
  { kind: "send", connectionId, message: { type: "error", code, message } },
];

const unchanged = (session: Session, outbound: readonly Outbound[]): SessionStep => ({ session, outbound });

const stateBroadcast = (session: Session, exclude: ReadonlySet<string> = new Set()): Outbound[] =>
  [...session.playerByConnection]
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

const handleJoin = (
  session: Session,
  connectionId: string,
  message: Extract<ClientMessage, { type: "join" }>,
  deps: SessionDeps,
): SessionStep => {
  const bound = session.playerByConnection.get(connectionId);
  if (bound !== undefined && message.playerId !== undefined && message.playerId !== bound) {
    return unchanged(session, errorTo(connectionId, "invalid_message", "This connection already joined as another player."));
  }
  const playerId = bound ?? message.playerId ?? deps.newPlayerId();
  const result = reduce(session.state, { type: "join", playerId, nickname: message.nickname });
  if (!result.ok) return unchanged(session, errorTo(connectionId, result.error.code, result.error.message));
  const next: Session = {
    state: result.state,
    playerByConnection: new Map(session.playerByConnection).set(connectionId, playerId),
  };
  const welcome: Outbound = {
    kind: "send",
    connectionId,
    message: { type: "welcome", playerId, state: toPublicState(result.state, playerId) },
  };
  return { session: next, outbound: [welcome, ...stateBroadcast(next, new Set([connectionId]))] };
};

export const handleMessage = (session: Session, connectionId: string, raw: string, deps: SessionDeps): SessionStep => {
  const message = parseRaw(raw);
  if (typeof message === "string") return unchanged(session, errorTo(connectionId, "invalid_message", message));
  if (message.type === "join") return handleJoin(session, connectionId, message, deps);
  const playerId = session.playerByConnection.get(connectionId);
  if (playerId === undefined) {
    return unchanged(session, errorTo(connectionId, "invalid_message", "Send a join message first."));
  }
  return applyEvent(session, connectionId, toGameEvent(message, playerId, deps));
};

export const handleClose = (session: Session, connectionId: string): SessionStep => {
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
