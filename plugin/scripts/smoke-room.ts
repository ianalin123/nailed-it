// End-to-end check against a running room server: two players, a plugin deck
// upload, one full round, and a takeover attempt that must be rejected.
// Usage: tsx scripts/smoke-room.ts --host localhost:8787
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WS from "ws";
import {
  PROTOCOL_VERSION,
  ROOM_PARTY,
  parseServerMessage,
  type ClientMessage,
  type Deck,
  type ServerMessage,
} from "@nailed-it/protocol";
import { submitDeck } from "./submit-deck";

const RESPONSE_TIMEOUT_MS = 5_000;

const hostFlag = process.argv.indexOf("--host");
const host = hostFlag >= 0 ? process.argv[hostFlag + 1] : undefined;
if (host === undefined) throw new Error("Missing required flag: --host");

const randomRoomCode = (): string =>
  Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

const deckFor = (owner: string): Deck => ({
  protocolVersion: PROTOCOL_VERSION,
  digestId: `digest-${owner}`,
  reads: [0.5, 0.6, 0.7].map((confidence, i) => ({
    id: `${owner}-r${i}`,
    text: `Invented read ${i} about the fictional player ${owner}.`,
    category: "work_style",
    confidence,
    evidenceIds: ["e1"],
    hops: 2,
    modelVersion: "teacher-v0",
  })),
});

interface Client {
  readonly send: (message: ClientMessage) => void;
  readonly next: (type: ServerMessage["type"]) => Promise<ServerMessage>;
  readonly close: () => void;
}

const connect = (room: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = new WS(`ws://${host}/parties/${ROOM_PARTY}/${room}`);
    const inbox: ServerMessage[] = [];
    const waiters: Array<(message: ServerMessage) => boolean> = [];
    socket.on("message", (data) => {
      const parsed = parseServerMessage(JSON.parse(String(data)));
      if (!parsed.success) throw new Error(`Server sent an off-protocol message: ${String(data)}`);
      const index = waiters.findIndex((accepts) => accepts(parsed.data));
      if (index >= 0) waiters.splice(index, 1);
      else inbox.push(parsed.data);
    });
    socket.on("error", reject);
    socket.on("open", () =>
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
        next: (type) =>
          new Promise((done, fail) => {
            const queued = inbox.findIndex((m) => m.type === type || m.type === "error");
            if (queued >= 0) {
              done(inbox.splice(queued, 1)[0] as ServerMessage);
              return;
            }
            const timer = setTimeout(() => fail(new Error(`No ${type} within ${RESPONSE_TIMEOUT_MS}ms`)), RESPONSE_TIMEOUT_MS);
            waiters.push((message) => {
              if (message.type !== type && message.type !== "error") return false;
              clearTimeout(timer);
              done(message);
              return true;
            });
          }),
      }),
    );
  });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
};

const expectType = <T extends ServerMessage["type"]>(message: ServerMessage, type: T): Extract<ServerMessage, { type: T }> => {
  if (message.type !== type) throw new Error(`Expected ${type}, got ${JSON.stringify(message)}`);
  return message as Extract<ServerMessage, { type: T }>;
};

const run = async (): Promise<void> => {
  const room = randomRoomCode();
  process.stdout.write(`Room ${room} on ${host}\n`);

  const ana = await connect(room);
  ana.send({ type: "join", nickname: "Ana" });
  const anaWelcome = expectType(await ana.next("welcome"), "welcome");
  check("first joiner is welcomed as host", anaWelcome.state.players[0]?.isHost === true);
  check("welcome carries a reconnect token", typeof anaWelcome.reconnectToken === "string");
  const anaToken = anaWelcome.reconnectToken;
  if (anaToken === undefined) throw new Error("No reconnect token issued, cannot continue");

  const bo = await connect(room);
  bo.send({ type: "join", nickname: "Bo" });
  const boWelcome = expectType(await bo.next("welcome"), "welcome");
  await ana.next("state");
  check("broadcast state never contains a token", !JSON.stringify(boWelcome.state).includes(anaToken));

  const mallory = await connect(room);
  mallory.send({ type: "join", nickname: "Mallory", playerId: anaWelcome.playerId });
  const attack = await mallory.next("welcome");
  check("takeover without a token is rejected", attack.type === "error" && attack.code === "bad_token", attack.type);
  mallory.close();

  const deckFile = join(mkdtempSync(join(tmpdir(), "nailed-it-smoke-")), "deck.json");
  writeFileSync(deckFile, JSON.stringify(deckFor("ana")));
  const upload = await submitDeck({
    room,
    playerId: anaWelcome.playerId,
    token: anaToken,
    host,
    deckFile,
    party: ROOM_PARTY,
    timeoutMs: RESPONSE_TIMEOUT_MS,
  });
  check("plugin uploads a deck for an existing player", upload.outcome === "success", upload.outcome);
  if (upload.outcome === "success") {
    const anaPlayer = upload.state.players.find((p) => p.id === anaWelcome.playerId);
    check("upload keeps the player's nickname", anaPlayer?.nickname === "Ana", anaPlayer?.nickname ?? "missing");
    check("upload marks the deck as submitted", anaPlayer?.hasDeck === true);
  }

  bo.send({ type: "submit_deck", deck: deckFor("bo") });
  await bo.next("state");

  ana.send({ type: "start", cardsPerPlayer: 1 });
  let state = expectType(await bo.next("state"), "state").state;
  while (state.status !== "playing") state = expectType(await bo.next("state"), "state").state;
  const round = state.round;
  if (round === undefined) throw new Error("Game started without a round");
  check("voting phase hides the truth and confidence", round.truth === undefined && round.readerConfidence === undefined);

  const hotSeatIsAna = round.hotSeatPlayerId === anaWelcome.playerId;
  const [hotSeat, guesser] = hotSeatIsAna ? [ana, bo] : [bo, ana];
  guesser.send({ type: "guess", readId: round.read.id, guess: "nailed" });
  await guesser.next("state");
  hotSeat.send({ type: "reveal", readId: round.read.id, truth: "nailed" });
  let revealed = expectType(await guesser.next("state"), "state").state;
  while (revealed.round?.phase !== "reveal") revealed = expectType(await guesser.next("state"), "state").state;
  const guesserId = hotSeatIsAna ? boWelcome.playerId : anaWelcome.playerId;
  check("reveal shows the truth", revealed.round.truth === "nailed");
  check("correct guess scores 100", revealed.players.find((p) => p.id === guesserId)?.score === 100);

  ana.close();
  bo.close();
};

try {
  await run();
} catch (error) {
  check("smoke run completed", false, error instanceof Error ? error.message : String(error));
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
