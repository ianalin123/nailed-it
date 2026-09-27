import { MAX_PLAYERS, MIN_PLAYERS, PROTOCOL_VERSION, type ErrorCode, type VerdictRecord } from "@nailed-it/protocol";
import { buildSchedule, type DeckHolder } from "./cards";
import { scoreRound } from "./scoring";
import type { Effect, GameEvent, InternalPlayer, InternalState, ReduceResult, ScheduledCard } from "./types";

type EventOf<T extends GameEvent["type"]> = Extract<GameEvent, { type: T }>;

export const createRoom = (code: string): InternalState => ({
  code,
  status: "lobby",
  players: [],
  hostId: undefined,
  schedule: [],
  roundIndex: 0,
  round: undefined,
  outcomes: [],
});

const fail = (code: ErrorCode, message: string): ReduceResult => ({ ok: false, error: { code, message } });

const succeed = (state: InternalState, effects: readonly Effect[] = []): ReduceResult => ({
  ok: true,
  state: withValidHost(state),
  effects,
});

const findPlayer = (state: InternalState, playerId: string): InternalPlayer | undefined =>
  state.players.find((p) => p.id === playerId);

const updatePlayer = (
  state: InternalState,
  playerId: string,
  update: (player: InternalPlayer) => InternalPlayer,
): InternalState => ({
  ...state,
  players: state.players.map((p) => (p.id === playerId ? update(p) : p)),
});

const connectedPlayers = (state: InternalState): readonly InternalPlayer[] => state.players.filter((p) => p.connected);

const withValidHost = (state: InternalState): InternalState => {
  const host = state.hostId === undefined ? undefined : findPlayer(state, state.hostId);
  if (host?.connected) return state;
  const successor = connectedPlayers(state)[0];
  if (successor) return { ...state, hostId: successor.id };
  return host ? state : { ...state, hostId: undefined };
};

export const currentCard = (state: InternalState): ScheduledCard | undefined =>
  state.status === "playing" ? state.schedule[state.roundIndex] : undefined;

const unknownPlayer = (playerId: string): ReduceResult =>
  fail("invalid_message", `Player ${playerId} has not joined this room.`);

const handleJoin = (state: InternalState, event: EventOf<"join">): ReduceResult => {
  if (findPlayer(state, event.playerId)) {
    return succeed(
      updatePlayer(state, event.playerId, (p) => ({ ...p, connected: true, nickname: event.nickname })),
    );
  }
  if (state.players.length >= MAX_PLAYERS) {
    return fail("room_full", `Room ${state.code} already has ${MAX_PLAYERS} players.`);
  }
  const player: InternalPlayer = {
    id: event.playerId,
    nickname: event.nickname,
    connected: true,
    score: 0,
    streak: 0,
    deck: undefined,
  };
  return succeed({ ...state, players: [...state.players, player] });
};

const handleDisconnect = (state: InternalState, event: EventOf<"disconnect">): ReduceResult => {
  if (!findPlayer(state, event.playerId)) return unknownPlayer(event.playerId);
  return succeed(updatePlayer(state, event.playerId, (p) => ({ ...p, connected: false })));
};

const handleSubmitDeck = (state: InternalState, event: EventOf<"submit_deck">): ReduceResult => {
  if (!findPlayer(state, event.playerId)) return unknownPlayer(event.playerId);
  if (state.status !== "lobby") return fail("wrong_phase", "Decks can only be submitted in the lobby.");
  return succeed(updatePlayer(state, event.playerId, (p) => ({ ...p, deck: event.deck })));
};

const deckHolders = (state: InternalState): DeckHolder[] =>
  connectedPlayers(state).flatMap((p) => (p.deck ? [{ playerId: p.id, deck: p.deck }] : []));

const MIN_DECKS = 2;

const votingRound = { phase: "voting", guesses: {}, truth: undefined, pointsAwarded: undefined } as const;

const handleStart = (state: InternalState, event: EventOf<"start">): ReduceResult => {
  if (!findPlayer(state, event.playerId)) return unknownPlayer(event.playerId);
  if (state.hostId !== event.playerId) return fail("not_host", "Only the host can start the game.");
  if (state.status !== "lobby") return fail("wrong_phase", "The game has already started.");
  if (connectedPlayers(state).length < MIN_PLAYERS) {
    return fail("not_enough_players", `At least ${MIN_PLAYERS} connected players are needed to start.`);
  }
  const holders = deckHolders(state);
  if (holders.length < MIN_DECKS) {
    return fail("not_enough_decks", `At least ${MIN_DECKS} connected players need a deck to start.`);
  }
  return succeed({
    ...state,
    status: "playing",
    schedule: buildSchedule(holders, event.cardsPerPlayer, event.random),
    roundIndex: 0,
    round: votingRound,
    outcomes: [],
  });
};

type VotingContext = { readonly card: ScheduledCard; readonly round: NonNullable<InternalState["round"]> };

const requireVoting = (state: InternalState, readId: string): VotingContext | ReduceResult => {
  const card = currentCard(state);
  if (!card || state.round?.phase !== "voting") return fail("wrong_phase", "No card is open for voting.");
  if (card.read.id !== readId) return fail("unknown_read", `Read ${readId} is not the card on the table.`);
  return { card, round: state.round };
};

const isFailure = (value: VotingContext | ReduceResult): value is ReduceResult => "ok" in value;

const handleGuess = (state: InternalState, event: EventOf<"guess">): ReduceResult => {
  if (!findPlayer(state, event.playerId)) return unknownPlayer(event.playerId);
  const context = requireVoting(state, event.readId);
  if (isFailure(context)) return context;
  if (context.card.hotSeatPlayerId === event.playerId) {
    return fail("invalid_message", "The hot seat cannot guess on their own card.");
  }
  return succeed({
    ...state,
    round: { ...context.round, guesses: { ...context.round.guesses, [event.playerId]: event.guess } },
  });
};

const countGuesses = (guesses: Readonly<Record<string, string>>): VerdictRecord["guessCounts"] => {
  const values = Object.values(guesses);
  return {
    nailed: values.filter((g) => g === "nailed").length,
    off: values.filter((g) => g === "off").length,
  };
};

const handleReveal = (state: InternalState, event: EventOf<"reveal">): ReduceResult => {
  if (!findPlayer(state, event.playerId)) return unknownPlayer(event.playerId);
  const context = requireVoting(state, event.readId);
  if (isFailure(context)) return context;
  if (context.card.hotSeatPlayerId !== event.playerId) {
    return fail("not_hot_seat", "Only the hot seat can reveal the truth.");
  }
  const { players, pointsAwarded } = scoreRound(state.players, context.round.guesses, event.truth);
  const record: VerdictRecord = {
    protocolVersion: PROTOCOL_VERSION,
    roomCode: state.code,
    recordedAt: event.recordedAt,
    digestId: context.card.digestId,
    read: context.card.read,
    truth: event.truth,
    guessCounts: countGuesses(context.round.guesses),
  };
  return succeed(
    {
      ...state,
      players,
      round: { ...context.round, phase: "reveal", truth: event.truth, pointsAwarded },
      outcomes: [...state.outcomes, event.truth],
    },
    [{ type: "verdict", record }],
  );
};

const advance = (state: InternalState): InternalState => {
  const nextIndex = state.roundIndex + 1;
  if (nextIndex >= state.schedule.length) {
    return { ...state, status: "finished", roundIndex: nextIndex, round: undefined };
  }
  return { ...state, roundIndex: nextIndex, round: votingRound };
};

const hotSeatAbsent = (state: InternalState, card: ScheduledCard): boolean =>
  findPlayer(state, card.hotSeatPlayerId)?.connected !== true;

const handleNext = (state: InternalState, event: EventOf<"next">): ReduceResult => {
  if (!findPlayer(state, event.playerId)) return unknownPlayer(event.playerId);
  if (state.hostId !== event.playerId) return fail("not_host", "Only the host can advance the game.");
  const card = currentCard(state);
  if (!card || !state.round) return fail("wrong_phase", "There is no round to advance.");
  if (state.round.phase === "voting" && !hotSeatAbsent(state, card)) {
    return fail("wrong_phase", "The hot seat has not revealed this card yet.");
  }
  return succeed(advance(state));
};

export const reduce = (state: InternalState, event: GameEvent): ReduceResult => {
  switch (event.type) {
    case "join":
      return handleJoin(state, event);
    case "disconnect":
      return handleDisconnect(state, event);
    case "submit_deck":
      return handleSubmitDeck(state, event);
    case "start":
      return handleStart(state, event);
    case "guess":
      return handleGuess(state, event);
    case "reveal":
      return handleReveal(state, event);
    case "next":
      return handleNext(state, event);
  }
};
