import { makeState } from "@/test/fixtures";
import { decodeServerMessage } from "./messages";

describe("decodeServerMessage", () => {
  it("accepts a valid state message", () => {
    const result = decodeServerMessage(JSON.stringify({ type: "state", state: makeState() }));
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON with the raw text in the detail", () => {
    const result = decodeServerMessage("{nope");
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.detail).toContain("Not valid JSON");
  });

  it("rejects schema violations with the failing path", () => {
    const result = decodeServerMessage(JSON.stringify({ type: "state", state: { ...makeState(), code: "TOOLONG" } }));
    expect(!result.ok && result.detail).toContain("state.code");
  });

  it("rejects unknown message types", () => {
    expect(decodeServerMessage(JSON.stringify({ type: "party_time" })).ok).toBe(false);
  });

  it("rejects binary frames", () => {
    expect(decodeServerMessage(new ArrayBuffer(4))).toEqual({
      ok: false,
      detail: "Expected a text message, got object.",
    });
  });
});
