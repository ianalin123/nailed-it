// Submits a validated Deck to a running Nailed It room on behalf of a player who
// already joined from the web client. It rejoins as that player using their
// reconnect token, then sends "submit_deck".
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import PartySocket from "partysocket";
import WS from "ws";
import type { ClientMessage, Deck, ErrorCode, RoomState } from "@nailed-it/protocol";
import { parseServerMessage, ROOM_PARTY } from "@nailed-it/protocol";
import { validateData } from "./validate";
import type { ValidationError } from "./validate";

export interface SubmitDeckArgs {
  room: string;
  playerId: string;
  token: string;
  host: string;
  deckFile: string;
  party: string;
  timeoutMs: number;
}

export type SubmitResult =
  | { outcome: "success"; state: RoomState }
  | { outcome: "validation_error"; errors: ValidationError[] }
  | { outcome: "server_error"; code: ErrorCode; message: string }
  | { outcome: "unrecognized_message"; raw: string }
  | { outcome: "connection_error"; message: string }
  | { outcome: "timeout" };

const DEFAULT_PARTY = ROOM_PARTY;
const DEFAULT_TIMEOUT_MS = 15_000;

export const parseArgs = (argv: string[]): SubmitDeckArgs => {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for --${key}`);
      }
      flags.set(key, value);
      i += 1;
    }
  }

  const room = flags.get("room");
  if (room === undefined) throw new Error("Missing required flag: --room");

  const playerId = flags.get("player-id");
  if (playerId === undefined) throw new Error("Missing required flag: --player-id");

  const token = flags.get("token") ?? process.env.NAILED_IT_TOKEN;
  if (token === undefined) {
    throw new Error("Missing --token and no NAILED_IT_TOKEN environment variable set");
  }

  const deckFile = flags.get("deck");
  if (deckFile === undefined) throw new Error("Missing required flag: --deck");

  const host = flags.get("host") ?? process.env.NAILED_IT_ROOM_HOST;
  if (host === undefined) {
    throw new Error(
      "Missing --host and no NAILED_IT_ROOM_HOST environment variable set",
    );
  }

  const party = flags.get("party") ?? process.env.NAILED_IT_ROOM_PARTY ?? DEFAULT_PARTY;

  const timeoutRaw = flags.get("timeout-ms");
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number.parseInt(timeoutRaw, 10);
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }

  return { room, playerId, token, host, deckFile, party, timeoutMs };
};

export type LoadDeckResult = { ok: true; deck: Deck } | { ok: false; errors: ValidationError[] };

export const loadAndValidateDeck = (deckFile: string): LoadDeckResult => {
  const raw = readFileSync(deckFile, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const result = validateData(parsed, "deck");
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, deck: parsed as Deck };
};

// The server keeps the player's existing nickname on rejoin, so this value is never shown.
const REJOIN_NICKNAME = "deck-upload";

export type SubmitPhase = "joining" | "submitting";

export type SubmitStep =
  | { kind: "send"; message: ClientMessage; phase: SubmitPhase }
  | { kind: "wait"; phase: SubmitPhase }
  | { kind: "done"; result: SubmitResult };

export const joinMessage = (args: Pick<SubmitDeckArgs, "playerId" | "token">): ClientMessage => ({
  type: "join",
  nickname: REJOIN_NICKNAME,
  playerId: args.playerId,
  token: args.token,
});

export const nextStep = (phase: SubmitPhase, raw: string, deck: Deck): SubmitStep => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "done", result: { outcome: "unrecognized_message", raw } };
  }
  const parsed = parseServerMessage(json);
  if (!parsed.success) return { kind: "done", result: { outcome: "unrecognized_message", raw } };
  const message = parsed.data;
  if (message.type === "error") {
    return { kind: "done", result: { outcome: "server_error", code: message.code, message: message.message } };
  }
  if (phase === "joining") {
    return message.type === "welcome"
      ? { kind: "send", message: { type: "submit_deck", deck }, phase: "submitting" }
      : { kind: "wait", phase };
  }
  return message.type === "state"
    ? { kind: "done", result: { outcome: "success", state: message.state } }
    : { kind: "wait", phase };
};

export const submitDeck = (args: SubmitDeckArgs): Promise<SubmitResult> =>
  new Promise((resolve) => {
    const loaded = loadAndValidateDeck(args.deckFile);
    if (!loaded.ok) {
      resolve({ outcome: "validation_error", errors: loaded.errors });
      return;
    }

    const socket = new PartySocket({
      host: args.host,
      room: args.room,
      party: args.party,
      WebSocket: WS,
      maxRetries: 0,
    });

    let phase: SubmitPhase = "joining";
    let settled = false;
    const finish = (result: SubmitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ outcome: "timeout" });
    }, args.timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(joinMessage(args)));
    });

    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const step = nextStep(phase, raw, loaded.deck);
      if (step.kind === "done") {
        finish(step.result);
        return;
      }
      phase = step.phase;
      if (step.kind === "send") socket.send(JSON.stringify(step.message));
    });

    socket.addEventListener("error", (event) => {
      finish({ outcome: "connection_error", message: event.message });
    });
  });

const describeResult = (result: SubmitResult): { message: string; exitCode: number } => {
  switch (result.outcome) {
    case "success":
      return {
        message: `Deck submitted. Room ${result.state.code} now has ${result.state.players.length} player(s) with hasDeck: ${result.state.players.map((p) => `${p.nickname}=${p.hasDeck}`).join(", ")}.`,
        exitCode: 0,
      };
    case "validation_error":
      return {
        message: [
          "Deck failed validation, not submitted:",
          ...result.errors.map((e) => `  ${e.path}: ${e.message}`),
        ].join("\n"),
        exitCode: 1,
      };
    case "server_error":
      return { message: `Server rejected the deck [${result.code}]: ${result.message}`, exitCode: 1 };
    case "unrecognized_message":
      return { message: `Received a message that isn't a valid ServerMessage: ${result.raw}`, exitCode: 1 };
    case "connection_error":
      return { message: `Connection error: ${result.message}`, exitCode: 1 };
    case "timeout":
      return { message: "Timed out waiting for the server to respond.", exitCode: 1 };
  }
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
};

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await submitDeck(args);
    const { message, exitCode } = describeResult(result);
    process.stdout.write(`${message}\n`);
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
