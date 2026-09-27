import type { Deck, ErrorCode, Guess, Read, RoomStatus, Truth, VerdictRecord } from "@nailed-it/protocol";

export type RandomSource = () => number;

export interface InternalPlayer {
  readonly id: string;
  readonly nickname: string;
  readonly connected: boolean;
  readonly score: number;
  readonly streak: number;
  readonly deck: Deck | undefined;
}

export interface ScheduledCard {
  readonly hotSeatPlayerId: string;
  readonly digestId: string;
  readonly read: Read;
}

export interface InternalRound {
  readonly phase: "voting" | "reveal";
  readonly guesses: Readonly<Record<string, Guess>>;
  readonly truth: Truth | undefined;
  readonly pointsAwarded: Readonly<Record<string, number>> | undefined;
}

export interface InternalState {
  readonly code: string;
  readonly status: RoomStatus;
  readonly players: readonly InternalPlayer[];
  readonly hostId: string | undefined;
  readonly schedule: readonly ScheduledCard[];
  readonly roundIndex: number;
  readonly round: InternalRound | undefined;
  readonly outcomes: readonly Truth[];
}

export type GameEvent =
  | { readonly type: "join"; readonly playerId: string; readonly nickname: string }
  | { readonly type: "disconnect"; readonly playerId: string }
  | { readonly type: "submit_deck"; readonly playerId: string; readonly deck: Deck }
  | {
      readonly type: "start";
      readonly playerId: string;
      readonly cardsPerPlayer: number;
      readonly random: RandomSource;
    }
  | { readonly type: "guess"; readonly playerId: string; readonly readId: string; readonly guess: Guess }
  | {
      readonly type: "reveal";
      readonly playerId: string;
      readonly readId: string;
      readonly truth: Truth;
      readonly recordedAt: string;
    }
  | { readonly type: "next"; readonly playerId: string };

export type Effect = { readonly type: "verdict"; readonly record: VerdictRecord };

export interface RoomError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type ReduceResult =
  | { readonly ok: true; readonly state: InternalState; readonly effects: readonly Effect[] }
  | { readonly ok: false; readonly error: RoomError };
