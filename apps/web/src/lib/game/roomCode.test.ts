import { checkNickname, generateRoomCode, isValidRoomCode, normalizeRoomCode } from "./roomCode";

describe("room codes", () => {
  it("normalizes user input to four uppercase letters", () => {
    expect(normalizeRoomCode(" ab-c d9e ")).toBe("ABCD");
  });

  it("validates exactly four letters", () => {
    expect(isValidRoomCode("ABCD")).toBe(true);
    expect(isValidRoomCode("ABC")).toBe(false);
    expect(isValidRoomCode("abcd")).toBe(false);
  });

  it("generates valid codes without ambiguous letters", () => {
    const codes = Array.from({ length: 200 }, () => generateRoomCode());
    codes.forEach((code) => {
      expect(isValidRoomCode(code)).toBe(true);
      expect(code).not.toMatch(/[IO]/);
    });
  });
});

describe("checkNickname", () => {
  it("trims and collapses whitespace", () => {
    expect(checkNickname("  Ada   L ")).toEqual({ ok: true, nickname: "Ada L" });
  });

  it("rejects empty and overlong names with a reason", () => {
    expect(checkNickname("   ")).toEqual({ ok: false, reason: "Enter a nickname." });
    expect(checkNickname("x".repeat(21)).ok).toBe(false);
  });
});
