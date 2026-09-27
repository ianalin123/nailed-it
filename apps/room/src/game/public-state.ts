import { PROTOCOL_VERSION, type Guess, type Player, type Round, type RoomState } from "@nailed-it/protocol";
import { currentCard } from "./reducer";
import { readerAccuracy } from "./scoring";
import type { InternalPlayer, InternalState } from "./types";

const toPublicPlayer =
  (hostId: string | undefined) =>
  (player: InternalPlayer): Player => ({
    id: player.id,
    nickname: player.nickname,
    isHost: player.id === hostId,
    connected: player.connected,
    hasDeck: player.deck !== undefined,
    deckSize: player.deck?.reads.length ?? 0,
    score: player.score,
    streak: player.streak,
  });

const ownGuess = (guesses: Readonly<Record<string, Guess>>, viewerId: string | undefined): Pick<Round, "yourGuess"> => {
  const guess = viewerId === undefined ? undefined : guesses[viewerId];
  return guess === undefined ? {} : { yourGuess: guess };
};

const toPublicRound = (state: InternalState, viewerId: string | undefined): Round | undefined => {
  const card = currentCard(state);
  const round = state.round;
  if (!card || !round) return undefined;
  const base: Round = {
    index: state.roundIndex,
    total: state.schedule.length,
    hotSeatPlayerId: card.hotSeatPlayerId,
    read: { id: card.read.id, text: card.read.text, category: card.read.category },
    phase: round.phase,
    votedPlayerIds: Object.keys(round.guesses),
    ...ownGuess(round.guesses, viewerId),
  };
  if (round.phase === "voting" || round.truth === undefined || round.pointsAwarded === undefined) return base;
  return {
    ...base,
    truth: round.truth,
    guesses: { ...round.guesses },
    readerConfidence: card.read.confidence,
    ...(card.read.chain ? { chain: card.read.chain.map((step) => ({ ...step })) } : {}),
    pointsAwarded: { ...round.pointsAwarded },
  };
};

const finishedAccuracy = (state: InternalState): Pick<RoomState, "readerAccuracy"> => {
  if (state.status !== "finished") return {};
  const accuracy = readerAccuracy(state.outcomes);
  return accuracy === undefined ? {} : { readerAccuracy: accuracy };
};

// viewerId is the player the view is for. Omit it for stage screens and other non-player viewers.
export const toPublicState = (state: InternalState, viewerId?: string): RoomState => {
  const round = toPublicRound(state, viewerId);
  return {
    protocolVersion: PROTOCOL_VERSION,
    code: state.code,
    status: state.status,
    players: state.players.map(toPublicPlayer(state.hostId)),
    ...(round ? { round } : {}),
    ...finishedAccuracy(state),
  };
};
