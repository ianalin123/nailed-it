import { PROTOCOL_VERSION, type Deck, type Read } from "@nailed-it/protocol";
import { expect } from "vitest";
import { createRoom, reduce } from "./reducer";
import type { GameEvent, InternalState, ReduceResult } from "./types";

export const ROOM = "ABCD";
export const NOW = "2026-09-27T12:00:00.000Z";

export const makeRead = (id: string, confidence: number): Read => ({
  id,
  text: `read ${id}`,
  category: "work_style",
  confidence,
  evidenceIds: [],
  hops: 2,
  modelVersion: "test-model",
});

export const makeDeck = (owner: string, confidences: readonly number[] = [0.6, 0.7, 0.5]): Deck => ({
  protocolVersion: PROTOCOL_VERSION,
  digestId: `digest-${owner}`,
  reads: confidences.map((c, i) => makeRead(`${owner}-r${i}`, c)),
});

export const firstRandom = (): number => 0;

export const expectOk = (result: ReduceResult): Extract<ReduceResult, { ok: true }> => {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result;
};

export const expectError = (result: ReduceResult, code: string): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    expect(result.error.message.length).toBeGreaterThan(0);
  }
};

export const apply = (state: InternalState, ...events: GameEvent[]): InternalState =>
  events.reduce((s, e) => expectOk(reduce(s, e)).state, state);

export const lobbyWith = (ids: readonly string[], withDecks: readonly string[] = ids): InternalState => {
  const joined = apply(createRoom(ROOM), ...ids.map((id): GameEvent => ({ type: "join", playerId: id, nickname: id })));
  return apply(
    joined,
    ...withDecks.map((id): GameEvent => ({ type: "submit_deck", playerId: id, deck: makeDeck(id) })),
  );
};

export const started = (ids: readonly string[], cardsPerPlayer = 1, withDecks: readonly string[] = ids): InternalState =>
  apply(lobbyWith(ids, withDecks), {
    type: "start",
    playerId: ids[0] ?? "",
    cardsPerPlayer,
    random: firstRandom,
  });
