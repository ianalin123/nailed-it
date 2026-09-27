import type { ClientMessage } from "@nailed-it/protocol";
import { generateRoomCode } from "@/lib/game/roomCode";
import type { SeatIdentity } from "./identity";

export type PlayerJoin = { role: "player"; nickname: string; create: boolean };
export type StageJoin = { role: "stage" };
export type JoinPlan = PlayerJoin | StageJoin;

export const STAGE_NICKNAME = "Stage";
export const MAX_CREATE_ATTEMPTS = 5;

const rejoin = (nickname: string, seat: SeatIdentity): ClientMessage =>
  seat.token === undefined
    ? { type: "join", nickname, playerId: seat.playerId }
    : { type: "join", nickname, playerId: seat.playerId, token: seat.token };

export const joinMessageFor = (plan: JoinPlan, seat: SeatIdentity | undefined): ClientMessage => {
  if (plan.role === "stage") return { type: "join", nickname: STAGE_NICKNAME, role: "stage" };
  if (seat) return rejoin(plan.nickname, seat);
  return plan.create ? { type: "join", nickname: plan.nickname, create: true } : { type: "join", nickname: plan.nickname };
};

export const shouldStoreSeat = (plan: JoinPlan): boolean => plan.role === "player";

export type CreateRetry = { kind: "retry"; code: string; attempt: number } | { kind: "give_up"; reason: string };

const MAX_CODE_DRAWS = 20;

export const planCreateRetry = (
  collidedCode: string,
  attempt: number,
  generate: () => string = generateRoomCode,
): CreateRetry => {
  if (attempt >= MAX_CREATE_ATTEMPTS) {
    return {
      kind: "give_up",
      reason: `Tried ${MAX_CREATE_ATTEMPTS} room codes and every one was taken. Try again in a moment.`,
    };
  }
  for (let draw = 0; draw < MAX_CODE_DRAWS; draw += 1) {
    const code = generate();
    if (code !== collidedCode) return { kind: "retry", code, attempt: attempt + 1 };
  }
  return { kind: "give_up", reason: "Couldn't come up with a new room code. Try again." };
};

export const parseCreateAttempt = (param: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(param) ? param[0] : param;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const attempt = Number(raw);
  return attempt >= 1 && attempt <= MAX_CREATE_ATTEMPTS ? attempt : undefined;
};
