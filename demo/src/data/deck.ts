import { Deck, Guess, Truth, type Read } from "@nailed-it/protocol";
import { z } from "zod";
import { parseWith } from "./json";

export const CONFIDENCE_BAND = { low: 0.45, high: 0.8 } as const;

export const bandDistance = (confidence: number): number => {
  if (confidence < CONFIDENCE_BAND.low) return CONFIDENCE_BAND.low - confidence;
  if (confidence > CONFIDENCE_BAND.high) return confidence - CONFIDENCE_BAND.high;
  return 0;
};

export const parseDeck = (raw: unknown): Deck => parseWith(Deck, raw, "deck.json");

const nickname = z.string().trim().min(1).max(20);
const delay = z.number().int().min(0).max(60_000);

const Guesser = z.object({ nickname, guess: Guess, joinAfterMs: delay, voteAfterMs: delay });

const CastSchema = z
  .object({
    hotSeat: z.object({ nickname }),
    phone: Guesser,
    guessers: z.array(Guesser).max(8),
    deckAfterMs: delay,
    lobbyHoldMs: delay,
    featuredReadId: z.string().min(1),
    truth: Truth,
    revealAfterLastVoteMs: delay,
  })
  .refine(
    (cast) => {
      const names = [cast.hotSeat.nickname, cast.phone.nickname, ...cast.guessers.map((g) => g.nickname)];
      return new Set(names.map((n) => n.toLowerCase())).size === names.length;
    },
    { message: "every nickname in the cast must be unique", path: ["guessers"] },
  );

export type Cast = z.infer<typeof CastSchema>;

export const parseCast = (raw: unknown): Cast => parseWith(CastSchema, raw, "cast.json");

export const findRead = (deck: Deck, id: string, field: string): Read => {
  const read = deck.reads.find((r) => r.id === id);
  if (!read) {
    const ids = deck.reads.map((r) => `"${r.id}"`).join(", ");
    throw new Error(`cast.json ${field} "${id}" is not a read id in deck.json. Ids in the deck: ${ids}`);
  }
  return read;
};

export const coldOpenRead = (deck: Deck, cast: Cast): Read => findRead(deck, cast.featuredReadId, "featuredReadId");

const hasChain = (read: Read): boolean => (read.chain?.length ?? 0) > 0;

export type DealPlan = { kind: "pinned"; deck: Deck } | { kind: "random"; deck: Deck; reason: string };

const MIN_DECK = 3;

export const planDeal = (deck: Deck, featuredReadId: string): DealPlan => {
  const featured = findRead(deck, featuredReadId, "featuredReadId");
  if (!hasChain(featured)) {
    throw new Error(
      `The featured read "${featured.id}" has no chain, so beat 6 (how it knew) would be empty. Give it a chain in deck.json or pick another featuredReadId.`,
    );
  }
  const featuredDistance = bandDistance(featured.confidence);
  const chained = deck.reads.filter(hasChain);
  const fartherOut = chained.filter((r) => r.id !== featured.id && bandDistance(r.confidence) > featuredDistance);
  if (fartherOut.length >= MIN_DECK - 1) {
    return { kind: "pinned", deck: { ...deck, reads: [featured, ...fartherOut] } };
  }
  if (chained.length < MIN_DECK) {
    throw new Error(`deck.json needs at least ${MIN_DECK} reads with a chain, found ${chained.length}.`);
  }
  return {
    kind: "random",
    deck: { ...deck, reads: chained },
    reason: `The server deals reads closest to the ${CONFIDENCE_BAND.low} to ${CONFIDENCE_BAND.high} confidence band first. To guarantee "${featured.id}" is dealt, deck.json needs at least ${MIN_DECK - 1} other chained reads further outside that band than it. Dealing a random chained read instead.`,
  };
};

export type ScriptedVote = { nickname: string; guess: Guess; atMs: number; isPhone: boolean };
export type RoundScript = { votes: ScriptedVote[]; revealAtMs: number };

export const roundScript = (cast: Cast): RoundScript => {
  const votes: ScriptedVote[] = [
    { nickname: cast.phone.nickname, guess: cast.phone.guess, atMs: cast.phone.voteAfterMs, isPhone: true },
    ...cast.guessers.map((g) => ({ nickname: g.nickname, guess: g.guess, atMs: g.voteAfterMs, isPhone: false })),
  ].sort((a, b) => a.atMs - b.atMs);
  const lastVote = Math.max(...votes.map((v) => v.atMs));
  return { votes, revealAtMs: lastVote + cast.revealAfterLastVoteMs };
};
