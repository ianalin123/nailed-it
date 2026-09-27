import { MAX_PLAYERS, MIN_PLAYERS, RoomState, VerdictRecord } from "@nailed-it/protocol";
import { describe, expect, it } from "vitest";
import {
  NOW,
  ROOM,
  apply,
  expectError,
  expectOk,
  firstRandom,
  lobbyWith,
  makeDeck,
  started,
} from "./fixtures.test-helpers";
import { toPublicState } from "./public-state";
import { createRoom, reduce } from "./reducer";
import type { GameEvent, InternalState } from "./types";

const currentReadId = (state: InternalState): string => {
  const card = state.schedule[state.roundIndex];
  if (!card) throw new Error("no current card");
  return card.read.id;
};

const hotSeat = (state: InternalState): string => {
  const card = state.schedule[state.roundIndex];
  if (!card) throw new Error("no current card");
  return card.hotSeatPlayerId;
};

const guess = (state: InternalState, playerId: string, value: "nailed" | "off"): GameEvent => ({
  type: "guess",
  playerId,
  readId: currentReadId(state),
  guess: value,
});

const reveal = (state: InternalState, truth: "nailed" | "partly" | "off"): GameEvent => ({
  type: "reveal",
  playerId: hotSeat(state),
  readId: currentReadId(state),
  truth,
  recordedAt: NOW,
});

const next = (playerId: string): GameEvent => ({ type: "next", playerId });

const player = (state: InternalState, id: string) => {
  const found = state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
};

describe("join", () => {
  it("makes the first joiner host", () => {
    const state = lobbyWith(["a", "b"], []);
    const view = toPublicState(state);
    expect(view.players.map((p) => [p.id, p.isHost])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("rejects joins beyond MAX_PLAYERS with room_full", () => {
    const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`);
    const full = lobbyWith(ids, []);
    expectError(reduce(full, { type: "join", playerId: "extra", nickname: "extra" }), "room_full");
  });

  it("treats a join with a known playerId as a reconnect, even when the room is full", () => {
    const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`);
    const full = apply(lobbyWith(ids, []), { type: "disconnect", playerId: "p3" });
    expect(player(full, "p3").connected).toBe(false);
    const back = expectOk(reduce(full, { type: "join", playerId: "p3", nickname: "renamed" })).state;
    expect(back.players).toHaveLength(MAX_PLAYERS);
    expect(player(back, "p3")).toMatchObject({ connected: true, nickname: "renamed" });
  });

  it("allows joining mid-game as a guesser", () => {
    const state = started(["a", "b"]);
    const joined = apply(state, { type: "join", playerId: "c", nickname: "c" });
    const guessed = expectOk(reduce(joined, guess(joined, "c", "nailed"))).state;
    expect(toPublicState(guessed).round?.votedPlayerIds).toContain("c");
  });
});

describe("disconnect and reconnect", () => {
  it("marks the player disconnected and keeps score, streak and deck", () => {
    let state = started(["a", "b", "c"]);
    const guesser = hotSeat(state) === "b" ? "c" : "b";
    state = apply(state, guess(state, guesser, "nailed"), reveal(state, "nailed"));
    state = apply(state, { type: "disconnect", playerId: guesser });
    expect(player(state, guesser)).toMatchObject({ connected: false, score: 100, streak: 1 });
    state = apply(state, { type: "join", playerId: guesser, nickname: guesser });
    expect(player(state, guesser)).toMatchObject({ connected: true, score: 100, streak: 1 });
  });

  it("hands host to the next connected player when the host disconnects", () => {
    const state = apply(lobbyWith(["a", "b", "c"], []), { type: "disconnect", playerId: "a" });
    expect(state.hostId).toBe("b");
    const back = apply(state, { type: "join", playerId: "a", nickname: "a" });
    expect(back.hostId).toBe("b");
  });

  it("keeps the host when nobody else is connected", () => {
    const state = apply(lobbyWith(["a"], []), { type: "disconnect", playerId: "a" });
    expect(state.hostId).toBe("a");
  });

  it("rejects disconnect for an unknown player", () => {
    expectError(reduce(createRoom(ROOM), { type: "disconnect", playerId: "ghost" }), "invalid_message");
  });
});

describe("submit_deck", () => {
  it("marks the player as having a deck without broadcasting the deck", () => {
    const state = lobbyWith(["a", "b"], ["a"]);
    const view = toPublicState(state);
    expect(view.players.find((p) => p.id === "a")?.hasDeck).toBe(true);
    expect(view.players.find((p) => p.id === "b")?.hasDeck).toBe(false);
    expect(JSON.stringify(view)).not.toContain("digest-a");
    expect(JSON.stringify(view)).not.toContain("a-r0");
  });

  it("replaces an earlier deck", () => {
    const state = apply(lobbyWith(["a"], ["a"]), {
      type: "submit_deck",
      playerId: "a",
      deck: { ...makeDeck("a"), digestId: "second" },
    });
    expect(player(state, "a").deck?.digestId).toBe("second");
  });

  it("rejects decks once the game has started", () => {
    expectError(reduce(started(["a", "b"]), { type: "submit_deck", playerId: "a", deck: makeDeck("a") }), "wrong_phase");
  });

  it("rejects decks from players who have not joined", () => {
    expectError(reduce(createRoom(ROOM), { type: "submit_deck", playerId: "x", deck: makeDeck("x") }), "invalid_message");
  });
});

describe("start", () => {
  const start = (playerId: string, cardsPerPlayer = 1): GameEvent => ({
    type: "start",
    playerId,
    cardsPerPlayer,
    random: firstRandom,
  });

  it("requires the host", () => {
    expectError(reduce(lobbyWith(["a", "b"]), start("b")), "not_host");
  });

  it("requires MIN_PLAYERS connected players", () => {
    expect(MIN_PLAYERS).toBe(2);
    expectError(reduce(lobbyWith(["a"]), start("a")), "not_enough_players");
    const oneLeft = apply(lobbyWith(["a", "b"]), { type: "disconnect", playerId: "b" });
    expectError(reduce(oneLeft, start("a")), "not_enough_players");
  });

  it("requires at least two players with decks", () => {
    expectError(reduce(lobbyWith(["a", "b", "c"], ["a"]), start("a")), "not_enough_decks");
  });

  it("rejects a second start", () => {
    expectError(reduce(started(["a", "b"]), start("a")), "wrong_phase");
  });

  it("enters voting on the first card with a rotating hot seat", () => {
    const state = expectOk(reduce(lobbyWith(["a", "b", "c"], ["a", "b"]), start("a", 2))).state;
    expect(state.status).toBe("playing");
    expect(state.schedule.map((c) => c.hotSeatPlayerId)).toEqual(["a", "b", "a", "b"]);
    const view = toPublicState(state);
    expect(view.round).toMatchObject({ index: 0, total: 4, hotSeatPlayerId: "a", phase: "voting", votedPlayerIds: [] });
  });

  it("rejects commands from unknown players", () => {
    expectError(reduce(lobbyWith(["a", "b"]), start("ghost")), "invalid_message");
  });
});

describe("guess", () => {
  it("records a guess and exposes only who voted", () => {
    const state = started(["a", "b", "c"]);
    const after = expectOk(reduce(state, guess(state, "b", "off"))).state;
    const round = toPublicState(after).round;
    expect(round?.votedPlayerIds).toEqual(["b"]);
  });

  it("lets a player change their guess until reveal", () => {
    let state = started(["a", "b"]);
    state = apply(state, guess(state, "b", "off"), guess(state, "b", "nailed"));
    expect(state.round?.guesses).toEqual({ b: "nailed" });
    expect(toPublicState(state).round?.votedPlayerIds).toEqual(["b"]);
  });

  it("rejects the hot seat guessing their own card", () => {
    const state = started(["a", "b"]);
    expectError(reduce(state, guess(state, "a", "nailed")), "invalid_message");
  });

  it("rejects a guess for a read that is not on the table", () => {
    const state = started(["a", "b"]);
    expectError(reduce(state, { type: "guess", playerId: "b", readId: "nope", guess: "off" }), "unknown_read");
  });

  it("rejects guesses in the lobby and after reveal", () => {
    expectError(reduce(lobbyWith(["a", "b"]), { type: "guess", playerId: "b", readId: "a-r0", guess: "off" }), "wrong_phase");
    let state = started(["a", "b"]);
    state = apply(state, reveal(state, "nailed"));
    expectError(reduce(state, guess(state, "b", "off")), "wrong_phase");
  });

  it("rejects guesses from unknown players", () => {
    const state = started(["a", "b"]);
    expectError(reduce(state, guess(state, "ghost", "off")), "invalid_message");
  });
});

describe("reveal", () => {
  it("only the hot seat may reveal", () => {
    const state = started(["a", "b"]);
    expectError(reduce(state, { ...reveal(state, "nailed"), playerId: "b" } as GameEvent), "not_hot_seat");
  });

  it("is allowed before everyone has guessed", () => {
    const state = started(["a", "b", "c"]);
    const after = expectOk(reduce(state, reveal(state, "off"))).state;
    expect(after.round?.phase).toBe("reveal");
  });

  it("rejects an unknown read and a second reveal", () => {
    const state = started(["a", "b"]);
    expectError(reduce(state, { ...reveal(state, "nailed"), readId: "nope" } as GameEvent), "unknown_read");
    const revealed = apply(state, reveal(state, "nailed"));
    expectError(reduce(revealed, reveal(revealed, "off")), "wrong_phase");
  });

  it("rejects reveal in the lobby", () => {
    expectError(
      reduce(lobbyWith(["a", "b"]), { type: "reveal", playerId: "a", readId: "a-r0", truth: "nailed", recordedAt: NOW }),
      "wrong_phase",
    );
  });

  it("emits a VerdictRecord effect with guess counts and the full read", () => {
    let state = started(["a", "b", "c", "d"]);
    state = apply(state, guess(state, "b", "nailed"), guess(state, "c", "nailed"), guess(state, "d", "off"));
    const result = expectOk(reduce(state, reveal(state, "partly")));
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0];
    expect(effect?.type).toBe("verdict");
    if (effect?.type !== "verdict") return;
    expect(VerdictRecord.safeParse(effect.record).success).toBe(true);
    expect(effect.record).toMatchObject({
      roomCode: ROOM,
      recordedAt: NOW,
      digestId: "digest-a",
      truth: "partly",
      guessCounts: { nailed: 2, off: 1 },
    });
    expect(effect.record.read.id).toBe(currentReadId(state));
    expect(effect.record.read.confidence).toBeTypeOf("number");
  });
});

describe("scoring", () => {
  const playRound = (state: InternalState, guesses: Record<string, "nailed" | "off">, truth: "nailed" | "partly" | "off") => {
    const withGuesses = apply(state, ...Object.entries(guesses).map(([id, g]) => guess(state, id, g)));
    return apply(withGuesses, reveal(withGuesses, truth));
  };

  it("pays 100 for a correct nailed guess and 100 for a correct off guess, 0 for wrong", () => {
    const state = playRound(started(["a", "b", "c", "d"]), { b: "nailed", c: "off" }, "nailed");
    expect(state.round?.pointsAwarded).toEqual({ b: 100, c: 0 });
    expect(player(state, "b")).toMatchObject({ score: 100, streak: 1 });
    expect(player(state, "c")).toMatchObject({ score: 0, streak: 0 });
    expect(player(state, "d")).toMatchObject({ score: 0, streak: 0 });

    const offState = playRound(started(["a", "b"]), { b: "off" }, "off");
    expect(player(offState, "b").score).toBe(100);
  });

  it("adds 25 per prior consecutive correct guess, capped at 100", () => {
    let state = started(["a", "b", "c"], 10);
    const earnedByB: number[] = [];
    while (state.status === "playing") {
      if (hotSeat(state) === "a") {
        const before = player(state, "b").score;
        state = playRound(state, { b: "nailed" }, "nailed");
        earnedByB.push(player(state, "b").score - before);
      } else {
        state = playRound(state, {}, "off");
      }
      state = apply(state, next("a"));
    }
    expect(earnedByB).toEqual([100, 125, 150]);
  });

  it("caps the streak bonus at 100", () => {
    let state = started(["a", "b", "c"], 10);
    const earned: number[] = [];
    while (state.status === "playing") {
      const guesser = hotSeat(state) === "c" ? "b" : "c";
      const before = player(state, guesser);
      const beforeStreak = before.streak;
      state = playRound(state, { [guesser]: "nailed" }, "nailed");
      if (guesser === "c") earned.push(player(state, "c").score - before.score);
      expect(player(state, guesser).streak).toBe(beforeStreak + 1);
      state = apply(state, next("a"));
    }
    expect(earned[0]).toBe(100);
    expect(Math.max(...earned)).toBe(200);
    expect(earned.filter((e) => e === 200).length).toBeGreaterThan(1);
  });

  it("resets the streak on a wrong guess", () => {
    let state = started(["a", "b", "c"], 3);
    state = playRound(state, { b: "nailed", c: "nailed" }, "nailed");
    state = apply(state, next("a"));
    state = playRound(state, { a: "nailed", c: "off" }, "nailed");
    expect(player(state, "c")).toMatchObject({ streak: 0 });
    expect(player(state, "a")).toMatchObject({ streak: 1 });
  });

  it("pays 50 to every guesser on partly and leaves streaks unchanged", () => {
    let state = started(["a", "b", "c", "d"], 2);
    state = playRound(state, { b: "nailed", c: "off" }, "nailed");
    expect(player(state, "b").streak).toBe(1);
    expect(player(state, "c").streak).toBe(0);
    state = apply(state, next("a"));
    expect(hotSeat(state)).toBe("b");
    state = playRound(state, { a: "nailed", c: "off" }, "partly");
    expect(state.round?.pointsAwarded).toEqual({ a: 50, c: 50 });
    expect(player(state, "c")).toMatchObject({ score: 50, streak: 0 });
    expect(player(state, "a")).toMatchObject({ score: 50, streak: 0 });
    expect(player(state, "d")).toMatchObject({ score: 0, streak: 0 });
    expect(player(state, "b")).toMatchObject({ score: 100, streak: 1 });
  });

  it("gives the hot seat nothing on their own card", () => {
    const state = playRound(started(["a", "b"]), { b: "nailed" }, "nailed");
    expect(player(state, "a")).toMatchObject({ score: 0, streak: 0 });
    expect(state.round?.pointsAwarded).not.toHaveProperty("a");
  });
});

describe("secrecy", () => {
  const forbidden = ["truth", "guesses", "readerConfidence", "pointsAwarded"] as const;

  it("hides truth, guesses, confidence and points during voting for every viewer", () => {
    let state = started(["a", "b", "c"]);
    state = apply(state, guess(state, "b", "nailed"), guess(state, "c", "off"));
    for (const viewer of [undefined, "a", "b", "c"]) {
      const view = toPublicState(state, viewer);
      expect(RoomState.safeParse(view).success).toBe(true);
      for (const key of forbidden) expect(view.round).not.toHaveProperty(key);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("confidence");
      expect(serialized).not.toContain("evidenceIds");
      expect(serialized).not.toContain("digest-");
    }
  });

  it("reveals truth, guesses, confidence and points in the reveal phase", () => {
    let state = started(["a", "b", "c"]);
    state = apply(state, guess(state, "b", "nailed"), guess(state, "c", "off"));
    state = apply(state, reveal(state, "nailed"));
    const view = toPublicState(state, "b");
    expect(RoomState.safeParse(view).success).toBe(true);
    expect(view.round).toMatchObject({
      phase: "reveal",
      truth: "nailed",
      guesses: { b: "nailed", c: "off" },
      readerConfidence: state.schedule[0]?.read.confidence,
      pointsAwarded: { b: 100, c: 0 },
    });
  });

  it("never exposes the read's confidence, evidence or model version through the round's read", () => {
    const view = toPublicState(started(["a", "b"]));
    expect(Object.keys(view.round?.read ?? {}).sort()).toEqual(["category", "id", "text"]);
  });
});

describe("next", () => {
  it("only the host may advance", () => {
    let state = started(["a", "b"], 2);
    state = apply(state, reveal(state, "nailed"));
    expectError(reduce(state, next("b")), "not_host");
  });

  it("requires the reveal phase", () => {
    expectError(reduce(started(["a", "b"]), next("a")), "wrong_phase");
    expectError(reduce(lobbyWith(["a", "b"]), next("a")), "wrong_phase");
  });

  it("skips the card without a verdict when the hot seat has disconnected during voting", () => {
    let state = started(["a", "b", "c"], 2);
    state = apply(state, { type: "disconnect", playerId: "a" });
    expect(state.hostId).toBe("b");
    const result = expectOk(reduce(state, next("b")));
    expect(result.effects).toEqual([]);
    expect(result.state.roundIndex).toBe(1);
    expect(result.state.outcomes).toEqual([]);
  });

  it("moves to the next round in voting with a clean slate", () => {
    let state = started(["a", "b"], 2);
    state = apply(state, guess(state, "b", "nailed"), reveal(state, "nailed"), next("a"));
    const view = toPublicState(state);
    expect(view.round).toMatchObject({ index: 1, hotSeatPlayerId: "b", phase: "voting", votedPlayerIds: [] });
  });

  it("finishes after the last round with reader accuracy counting partly as half", () => {
    let state = started(["a", "b"], 2);
    const truths = ["nailed", "partly", "off", "nailed"] as const;
    for (const truth of truths) {
      state = apply(state, reveal(state, truth), next("a"));
    }
    expect(state.status).toBe("finished");
    const view = toPublicState(state);
    expect(RoomState.safeParse(view).success).toBe(true);
    expect(view.status).toBe("finished");
    expect(view.round).toBeUndefined();
    expect(view.readerAccuracy).toBeCloseTo(2.5 / 4);
  });

  it("does not expose reader accuracy before the game finishes", () => {
    let state = started(["a", "b"], 2);
    state = apply(state, reveal(state, "nailed"));
    expect(toPublicState(state).readerAccuracy).toBeUndefined();
  });

  it("rejects next after finishing", () => {
    let state = started(["a", "b"]);
    state = apply(state, reveal(state, "nailed"), next("a"));
    state = apply(state, reveal(state, "nailed"));
    expect(state.status).toBe("playing");
    state = apply(state, next("a"));
    expect(state.status).toBe("finished");
    expectError(reduce(state, next("a")), "wrong_phase");
  });
});

describe("public state shape", () => {
  it("always satisfies the protocol RoomState schema", () => {
    expect(RoomState.safeParse(toPublicState(createRoom(ROOM))).success).toBe(true);
    expect(RoomState.safeParse(toPublicState(lobbyWith(["a", "b"]))).success).toBe(true);
    expect(RoomState.safeParse(toPublicState(started(["a", "b"]))).success).toBe(true);
  });
});
