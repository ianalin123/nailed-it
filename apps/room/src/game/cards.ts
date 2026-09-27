import type { Deck, Read } from "@nailed-it/protocol";
import type { RandomSource, ScheduledCard } from "./types";

export const CONFIDENCE_BAND = { low: 0.45, high: 0.8 } as const;

export const bandDistance = (confidence: number): number => {
  if (confidence < CONFIDENCE_BAND.low) return CONFIDENCE_BAND.low - confidence;
  if (confidence > CONFIDENCE_BAND.high) return confidence - CONFIDENCE_BAND.high;
  return 0;
};

export const selectCards = (reads: readonly Read[], count: number, random: RandomSource): Read[] =>
  reads
    .map((read) => ({ read, distance: bandDistance(read.confidence), tieBreak: random() }))
    .sort((x, y) => x.distance - y.distance || x.tieBreak - y.tieBreak)
    .slice(0, count)
    .map(({ read }) => read);

export interface DeckHolder {
  readonly playerId: string;
  readonly deck: Deck;
}

export const buildSchedule = (
  holders: readonly DeckHolder[],
  cardsPerPlayer: number,
  random: RandomSource,
): ScheduledCard[] => {
  const hands = holders.map((holder) => ({
    holder,
    cards: selectCards(holder.deck.reads, cardsPerPlayer, random),
  }));
  return Array.from({ length: cardsPerPlayer }, (_, turn) =>
    hands.flatMap(({ holder, cards }) => {
      const read = cards[turn];
      return read ? [{ hotSeatPlayerId: holder.playerId, digestId: holder.deck.digestId, read }] : [];
    }),
  ).flat();
};
