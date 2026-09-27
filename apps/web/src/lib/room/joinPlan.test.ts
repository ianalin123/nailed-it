import { ClientMessage } from "@nailed-it/protocol";
import { isValidRoomCode } from "@/lib/game/roomCode";
import {
  MAX_CREATE_ATTEMPTS,
  joinMessageFor,
  parseCreateAttempt,
  planCreateRetry,
  shouldStoreSeat,
} from "./joinPlan";

describe("joinMessageFor", () => {
  const seat = { playerId: "p1", token: "t1" };

  it("creates a room when asked and no seat is stored", () => {
    expect(joinMessageFor({ role: "player", nickname: "Ada", create: true }, undefined)).toEqual({
      type: "join",
      nickname: "Ada",
      create: true,
    });
  });

  it("joins an existing room without a create flag", () => {
    expect(joinMessageFor({ role: "player", nickname: "Ada", create: false }, undefined)).toEqual({
      type: "join",
      nickname: "Ada",
    });
  });

  it("rejoins with the stored seat and never re-creates", () => {
    expect(joinMessageFor({ role: "player", nickname: "Ada", create: true }, seat)).toEqual({
      type: "join",
      nickname: "Ada",
      playerId: "p1",
      token: "t1",
    });
  });

  it("omits a missing token", () => {
    expect(joinMessageFor({ role: "player", nickname: "Ada", create: false }, { playerId: "p1", token: undefined })).toEqual({
      type: "join",
      nickname: "Ada",
      playerId: "p1",
    });
  });

  it("joins the stage as a display with no identity", () => {
    const message = joinMessageFor({ role: "stage" }, seat);
    expect(message).toEqual({ type: "join", nickname: "Stage", role: "stage" });
    expect(ClientMessage.safeParse(message).success).toBe(true);
  });

  it("only stores seats for players", () => {
    expect(shouldStoreSeat({ role: "stage" })).toBe(false);
    expect(shouldStoreSeat({ role: "player", nickname: "Ada", create: false })).toBe(true);
  });
});

describe("planCreateRetry", () => {
  it("retries with a fresh code and a higher attempt number", () => {
    const plan = planCreateRetry("ABCD", 1, () => "WXYZ");
    expect(plan).toEqual({ kind: "retry", code: "WXYZ", attempt: 2 });
  });

  it("never retries with the code that collided", () => {
    const codes = ["ABCD", "ABCD", "QRST"];
    const plan = planCreateRetry("ABCD", 1, () => codes.shift() ?? "ZZZZ");
    expect(plan).toMatchObject({ kind: "retry", code: "QRST" });
  });

  it("gives up after the last attempt with a reason", () => {
    const plan = planCreateRetry("ABCD", MAX_CREATE_ATTEMPTS, () => "WXYZ");
    expect(plan.kind).toBe("give_up");
    expect(plan.kind === "give_up" && plan.reason).toMatch(/Try again/);
  });

  it("uses real codes by default", () => {
    const plan = planCreateRetry("ABCD", 1);
    expect(plan.kind === "retry" && isValidRoomCode(plan.code)).toBe(true);
  });
});

describe("parseCreateAttempt", () => {
  it("reads a positive attempt number within bounds", () => {
    expect(parseCreateAttempt("1")).toBe(1);
    expect(parseCreateAttempt(["3"])).toBe(3);
  });

  it("ignores absent, junk and out-of-range values", () => {
    expect(parseCreateAttempt(undefined)).toBeUndefined();
    expect(parseCreateAttempt("yes")).toBeUndefined();
    expect(parseCreateAttempt("0")).toBeUndefined();
    expect(parseCreateAttempt(String(MAX_CREATE_ATTEMPTS + 1))).toBeUndefined();
  });
});
