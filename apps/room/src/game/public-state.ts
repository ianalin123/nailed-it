import { PROTOCOL_VERSION, type Player, type Round, type RoomState } from "@nailed-it/protocol";
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
    score: player.score,
    streak: player.streak,
  });

const toPublicRound = (state: InternalState): Round | undefined => {
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
  };
  if (round.phase === "voting" || round.truth === undefined || round.pointsAwarded === undefined) return base;
  return {
    ...base,
    truth: round.truth,
    guesses: { ...round.guesses },
    readerConfidence: card.read.confidence,
    pointsAwarded: { ...round.pointsAwarded },
  };
};

const finishedAccuracy = (state: InternalState): Pick<RoomState, "readerAccuracy"> => {
  if (state.status !== "finished") return {};
  const accuracy = readerAccuracy(state.outcomes);
  return accuracy === undefined ? {} : { readerAccuracy: accuracy };
};

// The output is currently identical for every viewer; viewerId is threaded through so
// per-viewer views (e.g. showing a player their own pending guess) need no transport change.
export const toPublicState = (state: InternalState, _viewerId?: string): RoomState => {
  const round = toPublicRound(state);
  return {
    protocolVersion: PROTOCOL_VERSION,
    code: state.code,
    status: state.status,
    players: state.players.map(toPublicPlayer(state.hostId)),
    ...(round ? { round } : {}),
    ...finishedAccuracy(state),
  };
};
