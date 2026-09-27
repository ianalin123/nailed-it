import { makePlayer, makeRound, makeState } from "@/test/fixtures";
import {
  canAdvance,
  canGuess,
  canReveal,
  clampCardsPerPlayer,
  confidenceLine,
  guessOutcome,
  leaderboard,
  possessive,
  revealSummary,
  screenFor,
  startStatus,
  viewerRole,
  voteProgress,
} from "./selectors";

describe("screenFor", () => {
  it("maps status and phase to a screen", () => {
    expect(screenFor(makeState())).toBe("lobby");
    expect(screenFor(makeState({ status: "playing" }))).toBe("dealing");
    expect(screenFor(makeState({ status: "playing", round: makeRound() }))).toBe("voting");
    expect(screenFor(makeState({ status: "playing", round: makeRound({ phase: "reveal" }) }))).toBe("reveal");
    expect(screenFor(makeState({ status: "finished" }))).toBe("finished");
  });
});

describe("startStatus", () => {
  it("allows the host when there are enough players and decks", () => {
    expect(startStatus(makeState(), "a")).toEqual({ canStart: true });
  });

  it("tells non-hosts who they are waiting for", () => {
    expect(startStatus(makeState(), "b")).toEqual({ canStart: false, reason: "Waiting for Ada to start." });
  });

  it("explains a missing second player", () => {
    const state = makeState({ players: [makePlayer({ id: "a", nickname: "Ada", isHost: true, hasDeck: true })] });
    expect(startStatus(state, "a")).toEqual({
      canStart: false,
      reason: "Needs at least 2 players. 1 player here so far.",
    });
  });

  it("explains missing decks", () => {
    const state = makeState({
      players: [
        makePlayer({ id: "a", nickname: "Ada", isHost: true }),
        makePlayer({ id: "b", nickname: "Bo", hasDeck: true }),
      ],
    });
    expect(startStatus(state, "a")).toEqual({ canStart: false, reason: "Needs at least 2 decks. 1 in so far." });
  });

  it("says none when nobody has a deck", () => {
    const state = makeState({
      players: [makePlayer({ id: "a", isHost: true }), makePlayer({ id: "b" })],
    });
    expect(startStatus(state, "a")).toMatchObject({ reason: "Needs at least 2 decks. None in so far." });
  });

  it("refuses once the game is running", () => {
    expect(startStatus(makeState({ status: "playing" }), "a").canStart).toBe(false);
  });
});

describe("roles during a round", () => {
  const voting = makeState({ status: "playing", round: makeRound({ hotSeatPlayerId: "b" }) });
  const reveal = makeState({ status: "playing", round: makeRound({ hotSeatPlayerId: "b", phase: "reveal" }) });

  it("assigns hot seat, guesser and spectator", () => {
    expect(viewerRole(voting, "b")).toBe("hot_seat");
    expect(viewerRole(voting, "a")).toBe("guesser");
    expect(viewerRole(voting, "zzz")).toBe("spectator");
    expect(viewerRole(voting, undefined)).toBe("spectator");
  });

  it("lets guessers guess only while voting", () => {
    expect(canGuess(voting, "a")).toBe(true);
    expect(canGuess(voting, "b")).toBe(false);
    expect(canGuess(reveal, "a")).toBe(false);
  });

  it("lets only the hot seat reveal, only while voting", () => {
    expect(canReveal(voting, "b")).toBe(true);
    expect(canReveal(voting, "a")).toBe(false);
    expect(canReveal(reveal, "b")).toBe(false);
  });

  it("lets only the host advance, only after reveal", () => {
    expect(canAdvance(reveal, "a")).toBe(true);
    expect(canAdvance(reveal, "c")).toBe(false);
    expect(canAdvance(voting, "a")).toBe(false);
  });
});

describe("voteProgress", () => {
  it("counts votes from guessers only", () => {
    const state = makeState({
      status: "playing",
      round: makeRound({ hotSeatPlayerId: "b", votedPlayerIds: ["a", "b"] }),
    });
    expect(voteProgress(state)).toEqual({ voted: 1, eligible: 2, allIn: false });
  });

  it("reports when everyone is in", () => {
    const state = makeState({
      status: "playing",
      round: makeRound({ hotSeatPlayerId: "b", votedPlayerIds: ["a", "c"] }),
    });
    expect(voteProgress(state).allIn).toBe(true);
  });
});

describe("guessOutcome", () => {
  it("scores each combination", () => {
    expect(guessOutcome("nailed", "nailed")).toBe("correct");
    expect(guessOutcome("off", "nailed")).toBe("wrong");
    expect(guessOutcome("off", "partly")).toBe("partly");
    expect(guessOutcome(undefined, "off")).toBe("no_guess");
  });
});

describe("revealSummary", () => {
  it("is undefined while voting", () => {
    expect(revealSummary(makeState({ status: "playing", round: makeRound() }))).toBeUndefined();
  });

  it("lists every guesser with guess, outcome and points", () => {
    const state = makeState({
      status: "playing",
      round: makeRound({
        hotSeatPlayerId: "b",
        phase: "reveal",
        truth: "nailed",
        guesses: { a: "nailed", c: "off" },
        readerConfidence: 0.7,
        pointsAwarded: { a: 125, c: 0 },
      }),
    });
    const summary = revealSummary(state);
    expect(summary?.readerConfidence).toBe(0.7);
    expect(summary?.rows.map((row) => [row.player.id, row.guess, row.outcome, row.points])).toEqual([
      ["a", "nailed", "correct", 125],
      ["c", "off", "wrong", 0],
    ]);
  });
});

describe("leaderboard", () => {
  it("sorts by score and shares ranks on ties", () => {
    const board = leaderboard([
      makePlayer({ id: "a", nickname: "Ada", score: 200 }),
      makePlayer({ id: "b", nickname: "Bo", score: 300 }),
      makePlayer({ id: "c", nickname: "Cy", score: 200 }),
      makePlayer({ id: "d", nickname: "Di", score: 0 }),
    ]);
    expect(board.map((entry) => [entry.rank, entry.player.id])).toEqual([
      [1, "b"],
      [2, "a"],
      [2, "c"],
      [4, "d"],
    ]);
  });
});

describe("formatting", () => {
  it("phrases reader confidence", () => {
    expect(confidenceLine(0.7)).toBe("The reader was 70% sure.");
    expect(confidenceLine(undefined)).toBeUndefined();
  });

  it("clamps cards per player to the protocol range", () => {
    expect(clampCardsPerPlayer(0)).toBe(1);
    expect(clampCardsPerPlayer(11)).toBe(10);
    expect(clampCardsPerPlayer(3)).toBe(3);
  });

  it("makes possessives", () => {
    expect(possessive("Bo")).toBe("Bo's");
    expect(possessive("Moss")).toBe("Moss'");
  });
});
