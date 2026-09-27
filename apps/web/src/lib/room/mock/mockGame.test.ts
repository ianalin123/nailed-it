import { RoomState, type ClientMessage } from "@nailed-it/protocol";
import { buildDemoDeck } from "@/lib/game/demoDeck";
import { applyMessage, createMockGame, readerAccuracy, scoreGuess, toRoomState, type MockGame } from "./mockGame";

const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `p${count}`;
  };
};

const must = (game: MockGame, actor: string | undefined, message: ClientMessage, newId = ids()): MockGame => {
  const outcome = applyMessage(game, actor, message, newId);
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.game;
};

const lobbyWithTwoDecks = (): MockGame => {
  const newId = ids();
  let game = createMockGame("ABCD");
  game = must(game, undefined, { type: "join", nickname: "Ada" }, newId);
  game = must(game, undefined, { type: "join", nickname: "Bo" }, newId);
  game = must(game, undefined, { type: "join", nickname: "Cy" }, newId);
  game = must(game, "p1", { type: "submit_deck", deck: buildDemoDeck("a") });
  return must(game, "p2", { type: "submit_deck", deck: buildDemoDeck("b") });
};

describe("mock game engine", () => {
  it("makes the first joiner host and rejoins by player id with the matching token", () => {
    const game = lobbyWithTwoDecks();
    expect(game.players.map((player) => player.isHost)).toEqual([true, false, false]);
    const token = game.tokens.p1;
    const outcome = applyMessage(game, undefined, { type: "join", nickname: "Ada", playerId: "p1", ...(token ? { token } : {}) }, ids());
    expect(outcome.ok && outcome.joined?.playerId).toBe("p1");
    expect(outcome.ok && outcome.game.players).toHaveLength(3);
  });

  it("refuses to hand a seat to someone without its token", () => {
    const game = lobbyWithTwoDecks();
    const outcome = applyMessage(game, undefined, { type: "join", nickname: "Eve", playerId: "p1", token: "guess" }, ids());
    expect(outcome).toMatchObject({ ok: false, error: { code: "bad_token" } });
  });

  it("enforces start rules", () => {
    const game = lobbyWithTwoDecks();
    expect(applyMessage(game, "p2", { type: "start", cardsPerPlayer: 2 }, ids())).toMatchObject({
      ok: false,
      error: { code: "not_host" },
    });
    const oneDeck = { ...game, decks: {}, players: game.players.map((player) => ({ ...player, hasDeck: false })) };
    expect(applyMessage(oneDeck, "p1", { type: "start", cardsPerPlayer: 2 }, ids())).toMatchObject({
      ok: false,
      error: { code: "not_enough_decks" },
    });
  });

  it("deals rounds that rotate the hot seat", () => {
    const game = must(lobbyWithTwoDecks(), "p1", { type: "start", cardsPerPlayer: 2 });
    expect(game.cards.map((card) => card.hotSeatId)).toEqual(["p1", "p2", "p1", "p2"]);
    const state = toRoomState(game);
    expect(state.round).toMatchObject({ index: 0, total: 4, phase: "voting", hotSeatPlayerId: "p1" });
  });

  it("hides guesses until reveal and exposes them after", () => {
    let game = must(lobbyWithTwoDecks(), "p1", { type: "start", cardsPerPlayer: 1 });
    const readId = game.round?.card.read.id ?? "";
    game = must(game, "p2", { type: "guess", readId, guess: "nailed" });
    game = must(game, "p3", { type: "guess", readId, guess: "off" });
    game = must(game, "p3", { type: "guess", readId, guess: "nailed" });
    const voting = toRoomState(game).round;
    expect(voting?.votedPlayerIds).toEqual(["p2", "p3"]);
    expect(voting?.guesses).toBeUndefined();

    game = must(game, "p1", { type: "reveal", readId, truth: "nailed" });
    const revealed = toRoomState(game).round;
    expect(revealed?.phase).toBe("reveal");
    expect(revealed?.guesses).toEqual({ p2: "nailed", p3: "nailed" });
    expect(revealed?.pointsAwarded).toEqual({ p2: 100, p3: 100 });
    expect(revealed?.readerConfidence).toBeGreaterThan(0);
  });

  it("blocks the hot seat from guessing and others from revealing", () => {
    const game = must(lobbyWithTwoDecks(), "p1", { type: "start", cardsPerPlayer: 1 });
    const readId = game.round?.card.read.id ?? "";
    expect(applyMessage(game, "p1", { type: "guess", readId, guess: "off" }, ids()).ok).toBe(false);
    expect(applyMessage(game, "p2", { type: "reveal", readId, truth: "off" }, ids())).toMatchObject({
      ok: false,
      error: { code: "not_hot_seat" },
    });
    expect(applyMessage(game, "p2", { type: "guess", readId: "stale", guess: "off" }, ids())).toMatchObject({
      ok: false,
      error: { code: "unknown_read" },
    });
  });

  it("plays to the end and emits schema-valid states throughout", () => {
    let game = must(lobbyWithTwoDecks(), "p1", { type: "start", cardsPerPlayer: 1 });
    expect(RoomState.safeParse(toRoomState(game)).success).toBe(true);
    while (game.status === "playing" && game.round) {
      const { read, hotSeatId } = game.round.card;
      game = must(game, hotSeatId, { type: "reveal", readId: read.id, truth: "partly" });
      expect(RoomState.safeParse(toRoomState(game)).success).toBe(true);
      game = must(game, "p1", { type: "next" });
    }
    const final = toRoomState(game);
    expect(final.status).toBe("finished");
    expect(final.round).toBeUndefined();
    expect(final.readerAccuracy).toBe(0.5);
    expect(RoomState.safeParse(final).success).toBe(true);
  });
});

describe("scoreGuess", () => {
  it("pays 100 plus a capped streak bonus", () => {
    expect(scoreGuess("nailed", "nailed", 0)).toEqual({ points: 100, streak: 1 });
    expect(scoreGuess("nailed", "nailed", 1)).toEqual({ points: 125, streak: 2 });
    expect(scoreGuess("off", "off", 10)).toEqual({ points: 200, streak: 11 });
  });

  it("pays 50 for partly and resets on a miss", () => {
    expect(scoreGuess("off", "partly", 3)).toEqual({ points: 50, streak: 3 });
    expect(scoreGuess("off", "nailed", 3)).toEqual({ points: 0, streak: 0 });
    expect(scoreGuess(undefined, "nailed", 3)).toEqual({ points: 0, streak: 0 });
  });
});

describe("readerAccuracy", () => {
  it("counts partly as half", () => {
    expect(readerAccuracy(["nailed", "partly", "off", "nailed"])).toBe(0.625);
    expect(readerAccuracy([])).toBeUndefined();
  });
});
