import type { Guess, Truth } from "@nailed-it/protocol";
import type { InternalPlayer } from "./types";

export const CORRECT_POINTS = 100;
export const PARTLY_POINTS = 50;
export const STREAK_STEP = 25;
export const STREAK_BONUS_CAP = 100;

export const streakBonus = (priorStreak: number): number => Math.min(priorStreak * STREAK_STEP, STREAK_BONUS_CAP);

interface GuessOutcome {
  readonly points: number;
  readonly streak: number;
}

export const scoreGuess = (guess: Guess, truth: Truth, priorStreak: number): GuessOutcome => {
  if (truth === "partly") return { points: PARTLY_POINTS, streak: priorStreak };
  if (guess === truth) return { points: CORRECT_POINTS + streakBonus(priorStreak), streak: priorStreak + 1 };
  return { points: 0, streak: 0 };
};

interface RoundScore {
  readonly players: readonly InternalPlayer[];
  readonly pointsAwarded: Readonly<Record<string, number>>;
}

export const scoreRound = (
  players: readonly InternalPlayer[],
  guesses: Readonly<Record<string, Guess>>,
  truth: Truth,
): RoundScore => {
  const pointsAwarded: Record<string, number> = {};
  const scored = players.map((player) => {
    const guess = guesses[player.id];
    if (guess === undefined) return player;
    const outcome = scoreGuess(guess, truth, player.streak);
    pointsAwarded[player.id] = outcome.points;
    return { ...player, score: player.score + outcome.points, streak: outcome.streak };
  });
  return { players: scored, pointsAwarded };
};

export const truthCredit = (truth: Truth): number => {
  switch (truth) {
    case "nailed":
      return 1;
    case "partly":
      return 0.5;
    case "off":
      return 0;
  }
};

export const readerAccuracy = (outcomes: readonly Truth[]): number | undefined =>
  outcomes.length === 0 ? undefined : outcomes.reduce((sum, t) => sum + truthCredit(t), 0) / outcomes.length;
