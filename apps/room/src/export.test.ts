import { PROTOCOL_VERSION, VerdictRecord } from "@nailed-it/protocol";
import { describe, expect, it } from "vitest";
import { handleExportRequest, isExportAuthorized, toJsonl } from "./export";
import { makeRead } from "./game/fixtures.test-helpers";

const record = (id: string): VerdictRecord => ({
  protocolVersion: PROTOCOL_VERSION,
  roomCode: "ABCD",
  recordedAt: "2026-09-27T12:00:00.000Z",
  digestId: "digest",
  read: makeRead(id, 0.6),
  truth: "nailed",
  guessCounts: { nailed: 1, off: 0 },
});

describe("isExportAuthorized", () => {
  it("accepts only an exact match against a configured key", () => {
    expect(isExportAuthorized("secret-key", "secret-key")).toBe(true);
    expect(isExportAuthorized("secret-kez", "secret-key")).toBe(false);
    expect(isExportAuthorized("secret", "secret-key")).toBe(false);
    expect(isExportAuthorized(null, "secret-key")).toBe(false);
  });

  it("refuses everything when no key is configured", () => {
    expect(isExportAuthorized("", undefined)).toBe(false);
    expect(isExportAuthorized("", "")).toBe(false);
    expect(isExportAuthorized("anything", undefined)).toBe(false);
  });
});

describe("toJsonl", () => {
  it("writes one parseable record per line with a trailing newline", () => {
    const text = toJsonl([record("a"), record("b")]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(lines.slice(0, 2).map((l) => VerdictRecord.parse(JSON.parse(l)).read.id)).toEqual(["a", "b"]);
  });

  it("is empty for no records", () => {
    expect(toJsonl([])).toBe("");
  });
});

describe("handleExportRequest", () => {
  const load = async () => [record("a")];

  it("returns 401 without the right header", async () => {
    const missing = await handleExportRequest(new Request("https://x/parties/room/ABCD"), "k", load);
    expect(missing.status).toBe(401);
    const wrong = await handleExportRequest(
      new Request("https://x/parties/room/ABCD", { headers: { "x-export-key": "nope" } }),
      "k",
      load,
    );
    expect(wrong.status).toBe(401);
  });

  it("returns 405 for non-GET methods", async () => {
    const response = await handleExportRequest(
      new Request("https://x/parties/room/ABCD", { method: "POST", headers: { "x-export-key": "k" } }),
      "k",
      load,
    );
    expect(response.status).toBe(405);
  });

  it("returns verdicts as JSONL with the right key", async () => {
    const response = await handleExportRequest(
      new Request("https://x/parties/room/ABCD", { headers: { "x-export-key": "k" } }),
      "k",
      load,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await response.text()).toBe(`${JSON.stringify(record("a"))}\n`);
  });
});
