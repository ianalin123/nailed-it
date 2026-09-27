import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Deck } from "@nailed-it/protocol";
import { PROTOCOL_VERSION } from "@nailed-it/protocol";
import { joinMessage, loadAndValidateDeck, nextStep, parseArgs } from "./submit-deck";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("parseArgs", () => {
  it("parses all required flags", () => {
    const args = parseArgs([
      "--room",
      "ABCD",
      "--player-id",
      "p1",
      "--token",
      "t1",
      "--deck",
      "deck.json",
      "--host",
      "localhost:1999",
    ]);
    expect(args).toEqual({
      room: "ABCD",
      playerId: "p1",
      token: "t1",
      deckFile: "deck.json",
      host: "localhost:1999",
      party: "room",
      timeoutMs: 15_000,
    });
  });

  it("falls back to NAILED_IT_ROOM_HOST when --host is omitted", () => {
    process.env.NAILED_IT_ROOM_HOST = "env-host:1999";
    const args = parseArgs(["--room", "ABCD", "--player-id", "p1", "--token", "t1", "--deck", "deck.json"]);
    expect(args.host).toBe("env-host:1999");
  });

  it("throws when neither --host nor NAILED_IT_ROOM_HOST is set", () => {
    delete process.env.NAILED_IT_ROOM_HOST;
    expect(() => parseArgs(["--room", "ABCD", "--player-id", "p1", "--token", "t1", "--deck", "deck.json"])).toThrow(
      /NAILED_IT_ROOM_HOST/,
    );
  });

  it("throws when --room is missing", () => {
    expect(() => parseArgs(["--player-id", "p1", "--token", "t1", "--deck", "deck.json", "--host", "h"])).toThrow(
      /--room/,
    );
  });

  it("throws when --player-id is missing", () => {
    expect(() => parseArgs(["--room", "ABCD", "--token", "t1", "--deck", "deck.json", "--host", "h"])).toThrow(
      /--player-id/,
    );
  });

  it("accepts a custom --party and --timeout-ms", () => {
    const args = parseArgs([
      "--room",
      "ABCD",
      "--player-id",
      "p1",
      "--token",
      "t1",
      "--deck",
      "deck.json",
      "--host",
      "h",
      "--party",
      "game-room",
      "--timeout-ms",
      "5000",
    ]);
    expect(args.party).toBe("game-room");
    expect(args.timeoutMs).toBe(5000);
  });

  it("throws on a non-positive --timeout-ms", () => {
    expect(() =>
      parseArgs([
        "--room",
        "ABCD",
        "--player-id",
        "p1",
        "--token",
        "t1",
        "--deck",
        "deck.json",
        "--host",
        "h",
        "--timeout-ms",
        "0",
      ]),
    ).toThrow(/--timeout-ms/);
  });
});

describe("token handling", () => {
  it("throws when neither --token nor NAILED_IT_TOKEN is set", () => {
    delete process.env.NAILED_IT_TOKEN;
    expect(() => parseArgs(["--room", "ABCD", "--player-id", "p1", "--deck", "d.json", "--host", "h"])).toThrow(
      /NAILED_IT_TOKEN/,
    );
  });

  it("reads the token from NAILED_IT_TOKEN so it stays out of the process list", () => {
    process.env.NAILED_IT_TOKEN = "from-env";
    const args = parseArgs(["--room", "ABCD", "--player-id", "p1", "--deck", "d.json", "--host", "h"]);
    expect(args.token).toBe("from-env");
  });
});

describe("submit flow", () => {
  const read = {
    id: "r1",
    text: "You label your moving boxes by room and by priority.",
    category: "work_style" as const,
    confidence: 0.6,
    evidenceIds: ["e1"],
    hops: 2,
    modelVersion: "teacher-v0",
  };
  const deck: Deck = {
    protocolVersion: PROTOCOL_VERSION,
    digestId: "d1",
    reads: [read, { ...read, id: "r2" }, { ...read, id: "r3" }],
  };
  const state = { protocolVersion: PROTOCOL_VERSION, code: "ABCD", status: "lobby", players: [] };

  it("joins as the existing player with their token before anything else", () => {
    expect(joinMessage({ playerId: "p1", token: "t1" })).toMatchObject({ type: "join", playerId: "p1", token: "t1" });
  });

  it("sends the deck only after the server welcomes the rejoin", () => {
    const step = nextStep("joining", JSON.stringify({ type: "welcome", playerId: "p1", state }), deck);
    expect(step).toEqual({ kind: "send", message: { type: "submit_deck", deck }, phase: "submitting" });
  });

  it("does not treat a state broadcast during joining as success", () => {
    expect(nextStep("joining", JSON.stringify({ type: "state", state }), deck)).toEqual({ kind: "wait", phase: "joining" });
  });

  it("succeeds on the state that follows the submission", () => {
    const step = nextStep("submitting", JSON.stringify({ type: "state", state }), deck);
    expect(step).toMatchObject({ kind: "done", result: { outcome: "success" } });
  });

  it("reports a rejected token as a server error", () => {
    const raw = JSON.stringify({ type: "error", code: "bad_token", message: "no" });
    expect(nextStep("joining", raw, deck)).toMatchObject({ kind: "done", result: { outcome: "server_error", code: "bad_token" } });
  });

  it("reports unparseable and off-protocol messages", () => {
    expect(nextStep("joining", "{nope", deck)).toMatchObject({ kind: "done", result: { outcome: "unrecognized_message" } });
    expect(nextStep("joining", JSON.stringify({ type: "dance" }), deck)).toMatchObject({
      kind: "done",
      result: { outcome: "unrecognized_message" },
    });
  });
});

describe("loadAndValidateDeck", () => {
  const dir = mkdtempSync(join(tmpdir(), "nailed-it-plugin-test-"));

  const validRead = {
    id: "r1",
    text: "You default to small composable functions before reaching for a framework.",
    category: "technical_identity" as const,
    confidence: 0.62,
    evidenceIds: ["e1"],
    hops: 2,
    modelVersion: "teacher-v0",
  };

  const validDeck: Deck = {
    protocolVersion: PROTOCOL_VERSION,
    digestId: "digest-1",
    reads: [validRead, { ...validRead, id: "r2" }, { ...validRead, id: "r3" }],
  };

  it("loads and accepts a valid deck file", () => {
    const filePath = join(dir, "valid-deck.json");
    writeFileSync(filePath, JSON.stringify(validDeck));
    const result = loadAndValidateDeck(filePath);
    expect(result.ok).toBe(true);
  });

  it("rejects a deck file that fails schema validation, with errors intact", () => {
    const filePath = join(dir, "invalid-deck.json");
    writeFileSync(filePath, JSON.stringify({ ...validDeck, reads: [] }));
    const result = loadAndValidateDeck(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
