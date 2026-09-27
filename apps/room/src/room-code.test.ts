import { describe, expect, it } from "vitest";
import { isValidRoomCode } from "./room-code";

describe("isValidRoomCode", () => {
  it("accepts exactly four uppercase letters", () => {
    expect(isValidRoomCode("ABCD")).toBe(true);
    for (const bad of ["abcd", "ABC", "ABCDE", "AB1D", "", "AB D"]) expect(isValidRoomCode(bad)).toBe(false);
  });
});
