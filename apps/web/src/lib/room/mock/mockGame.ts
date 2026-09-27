import {
  MAX_PLAYERS,
  MIN_DECKS,
  MIN_PLAYERS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Deck,
  type ErrorCode,
  type Guess,
  type Player,
  type Read,
  type RoomState,
  type RoomStatus,
  type Truth,
} from "@nailed-it/protocol";

const CORRECT_POINTS = 100;
const PARTLY_POINTS = 50;
const STREAK_STEP = 25;
const STREAK_CAP = 100;

type Card = { hotSeatId: string; read: Read };

type ActiveRound = {
  index: number;
  card: Card;
  guesses: Record<string, Guess>;
  truth: Truth | undefined;
  points: Record<string, number> | undefined;
};

export type MockGame = {
  code: string;
  created: boolean;
  stageIds: string[];
  status: RoomStatus;
  players: Player[];
  decks: Record<string, Deck>;
  tokens: Record<string, string>;
  cards: Card[];
  round: ActiveRound | undefined;
  truths: Truth[];
};

export type MockError = { code: ErrorCode; message: string };

export type MockOutcome =
  | { ok: true; game: MockGame; joined?: { playerId: string; token: string | undefined } }
  | { ok: false; error: MockError };

export const createMockGame = (code: string, created = false): MockGame => ({
  code,
  created,
  stageIds: [],
  status: "lobby",
  players: [],
  decks: {},
  tokens: {},
  cards: [],
  round: undefined,
  truths: [],
});

const fail = (code: ErrorCode, message: string): MockOutcome => ({ ok: false, error: { code, message } });

const updatePlayer = (game: MockGame, id: string, patch: Partial<Player>): MockGame => ({
  ...game,
  players: game.players.map((player) => (player.id === id ? { ...player, ...patch } : player)),
});

export const setConnected = (game: MockGame, playerId: string, connected: boolean): MockGame =>
  updatePlayer(game, playerId, { connected });

const join = (
  game: MockGame,
  message: Extract<ClientMessage, { type: "join" }>,
  newId: () => string,
): MockOutcome => {
  if (message.create === true) {
    if (game.created) return fail("room_exists", `Room ${game.code} already exists. Pick another code.`);
    return joinAsPlayer({ ...game, created: true }, message, newId);
  }
  if (!game.created) return fail("room_not_found", `There's no room ${game.code}. Check the code on the host's screen.`);
  if (message.role === "stage") {
    const stageId = `stage-${newId()}`;
    return { ok: true, game: { ...game, stageIds: [...game.stageIds, stageId] }, joined: { playerId: stageId, token: undefined } };
  }
  return joinAsPlayer(game, message, newId);
};

const joinAsPlayer = (
  game: MockGame,
  message: Extract<ClientMessage, { type: "join" }>,
  newId: () => string,
): MockOutcome => {
  const existing = message.playerId
    ? game.players.find((player) => player.id === message.playerId)
    : undefined;
  if (existing) {
    const token = game.tokens[existing.id];
    if (token === undefined || message.token !== token) {
      return fail("bad_token", "That seat belongs to someone else. Join as a new player.");
    }
    const updated = updatePlayer(game, existing.id, { connected: true, nickname: message.nickname });
    return { ok: true, game: updated, joined: { playerId: existing.id, token } };
  }
  if (game.players.length >= MAX_PLAYERS) return fail("room_full", `This room already has ${MAX_PLAYERS} players.`);
  const player: Player = {
    id: newId(),
    nickname: message.nickname,
    isHost: game.players.length === 0,
    connected: true,
    hasDeck: false,
    score: 0,
    streak: 0,
  };
  const token = `token-${player.id}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    ok: true,
    game: { ...game, players: [...game.players, player], tokens: { ...game.tokens, [player.id]: token } },
    joined: { playerId: player.id, token },
  };
};

export const dealCards = (players: readonly Player[], decks: Record<string, Deck>, perPlayer: number): Card[] => {
  const seats = players.filter((player) => decks[player.id]);
  const cards: Card[] = [];
  for (let turn = 0; turn < perPlayer; turn += 1) {
    for (const seat of seats) {
      const read = decks[seat.id]?.reads[turn];
      if (read) cards.push({ hotSeatId: seat.id, read });
    }
  }
  return cards;
};

const openRound = (game: MockGame, index: number): MockGame => {
  const card = game.cards[index];
  if (!card) return { ...game, status: "finished", round: undefined };
  return { ...game, round: { index, card, guesses: {}, truth: undefined, points: undefined } };
};

const start = (game: MockGame, actorId: string, perPlayer: number): MockOutcome => {
  const actor = game.players.find((player) => player.id === actorId);
  if (!actor?.isHost) return fail("not_host", "Only the host can start the game.");
  if (game.status !== "lobby") return fail("wrong_phase", "The game has already started.");
  if (game.players.length < MIN_PLAYERS) return fail("not_enough_players", `Need at least ${MIN_PLAYERS} players.`);
  const decks = game.players.filter((player) => game.decks[player.id]).length;
  if (decks < MIN_DECKS) return fail("not_enough_decks", `Need at least ${MIN_DECKS} decks.`);
  const cards = dealCards(game.players, game.decks, perPlayer);
  return { ok: true, game: openRound({ ...game, status: "playing", cards }, 0) };
};

const guess = (game: MockGame, actorId: string, readId: string, value: Guess): MockOutcome => {
  const round = game.round;
  if (game.status !== "playing" || !round || round.truth !== undefined) {
    return fail("wrong_phase", "Guessing is closed for this card.");
  }
  if (round.card.read.id !== readId) return fail("unknown_read", "That card is no longer in play.");
  if (round.card.hotSeatId === actorId) return fail("hot_seat_cannot_guess", "You can't guess on your own card.");
  return { ok: true, game: { ...game, round: { ...round, guesses: { ...round.guesses, [actorId]: value } } } };
};

export const scoreGuess = (
  value: Guess | undefined,
  truth: Truth,
  streak: number,
): { points: number; streak: number } => {
  if (value === undefined) return { points: 0, streak: 0 };
  if (truth === "partly") return { points: PARTLY_POINTS, streak };
  if (value !== truth) return { points: 0, streak: 0 };
  const nextStreak = streak + 1;
  return { points: CORRECT_POINTS + Math.min(STREAK_CAP, STREAK_STEP * (nextStreak - 1)), streak: nextStreak };
};

const reveal = (game: MockGame, actorId: string, readId: string, truth: Truth): MockOutcome => {
  const round = game.round;
  if (game.status !== "playing" || !round || round.truth !== undefined) {
    return fail("wrong_phase", "This card has already been revealed.");
  }
  if (round.card.read.id !== readId) return fail("unknown_read", "That card is no longer in play.");
  if (round.card.hotSeatId !== actorId) return fail("not_hot_seat", "Only the player in the hot seat can reveal.");
  const points: Record<string, number> = {};
  const players = game.players.map((player) => {
    if (player.id === round.card.hotSeatId) return player;
    const scored = scoreGuess(round.guesses[player.id], truth, player.streak);
    points[player.id] = scored.points;
    return { ...player, score: player.score + scored.points, streak: scored.streak };
  });
  return {
    ok: true,
    game: { ...game, players, truths: [...game.truths, truth], round: { ...round, truth, points } },
  };
};

const next = (game: MockGame, actorId: string): MockOutcome => {
  const actor = game.players.find((player) => player.id === actorId);
  if (!actor?.isHost) return fail("not_host", "Only the host can move to the next card.");
  if (!game.round || game.round.truth === undefined) return fail("wrong_phase", "Reveal this card first.");
  return { ok: true, game: openRound(game, game.round.index + 1) };
};

export const applyMessage = (
  game: MockGame,
  actorId: string | undefined,
  message: ClientMessage,
  newId: () => string,
): MockOutcome => {
  if (message.type === "join") return join(game, message, newId);
  if (!actorId) return fail("not_joined", "Join the room first.");
  if (game.stageIds.includes(actorId)) return fail("stage_cannot_act", "The big screen only watches.");
  switch (message.type) {
    case "submit_deck": {
      if (game.status !== "lobby") return fail("wrong_phase", "Decks can only be submitted in the lobby.");
      const withDeck = { ...game, decks: { ...game.decks, [actorId]: message.deck } };
      return { ok: true, game: updatePlayer(withDeck, actorId, { hasDeck: true, deckSize: message.deck.reads.length }) };
    }
    case "start":
      return start(game, actorId, message.cardsPerPlayer);
    case "guess":
      return guess(game, actorId, message.readId, message.guess);
    case "reveal":
      return reveal(game, actorId, message.readId, message.truth);
    case "next":
      return next(game, actorId);
  }
};

const TRUTH_SCORE: Record<Truth, number> = { nailed: 1, partly: 0.5, off: 0 };

export const readerAccuracy = (truths: readonly Truth[]): number | undefined =>
  truths.length === 0 ? undefined : truths.reduce((sum, truth) => sum + TRUTH_SCORE[truth], 0) / truths.length;

export const toRoomState = (game: MockGame, viewerId?: string): RoomState => {
  const accuracy = readerAccuracy(game.truths);
  const round = game.round;
  const base: RoomState = {
    protocolVersion: PROTOCOL_VERSION,
    code: game.code,
    status: game.status,
    players: game.players,
    ...(accuracy === undefined ? {} : { readerAccuracy: accuracy }),
  };
  if (!round || game.status !== "playing") return base;
  const revealed = round.truth !== undefined;
  const yourGuess = viewerId === undefined ? undefined : round.guesses[viewerId];
  const chain = round.card.read.chain;
  return {
    ...base,
    round: {
      index: round.index,
      total: game.cards.length,
      hotSeatPlayerId: round.card.hotSeatId,
      read: { id: round.card.read.id, text: round.card.read.text, category: round.card.read.category },
      phase: revealed ? "reveal" : "voting",
      votedPlayerIds: Object.keys(round.guesses),
      ...(yourGuess === undefined ? {} : { yourGuess }),
      ...(revealed && chain && chain.length > 0 ? { chain } : {}),
      ...(revealed && round.truth !== undefined
        ? {
            truth: round.truth,
            guesses: round.guesses,
            readerConfidence: round.card.read.confidence,
            pointsAwarded: round.points ?? {},
          }
        : {}),
    },
  };
};
