import WS from "ws";
import {
  ROOM_PARTY,
  parseServerMessage,
  type ClientMessage,
  type RoomState,
  type ServerMessage,
} from "@nailed-it/protocol";
import type { SecretBook } from "./secrets";

const REPLY_TIMEOUT_MS = 8_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWZ";
const CREATE_ATTEMPTS = 5;

type Waiter = { accepts: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void };

export type Bot = {
  nickname: string;
  playerId: string;
  send: (message: ClientMessage) => void;
  latest: () => RoomState;
  waitForState: (description: string, accepts: (state: RoomState) => boolean, timeoutMs?: number) => Promise<RoomState>;
  close: () => void;
};

export type Wire = {
  send: (message: ClientMessage) => void;
  next: (description: string, accepts: (message: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  lastState: () => RoomState | undefined;
  close: () => void;
};

const openWire = (host: string, room: string, who: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WS(`ws://${host}/parties/${ROOM_PARTY}/${room}`);
    const waiters: Waiter[] = [];
    let state: RoomState | undefined;
    let protocolError: Error | undefined;
    socket.on("message", (data) => {
      const parsed = parseServerMessage(JSON.parse(String(data)));
      if (!parsed.success) {
        protocolError = new Error(`${who} received an off-protocol message from the room server`);
        return;
      }
      const message = parsed.data;
      if (message.type === "state" || message.type === "welcome") state = message.state;
      for (const waiter of [...waiters]) {
        if (waiter.accepts(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    socket.once("error", (error) => reject(new Error(`${who} could not connect to ws://${host}: ${error.message}`)));
    socket.once("open", () =>
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        lastState: () => state,
        close: () => socket.close(),
        next: (description, accepts, timeoutMs = REPLY_TIMEOUT_MS) =>
          new Promise((done, fail) => {
            if (protocolError) {
              fail(protocolError);
              return;
            }
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              fail(new Error(`${who}: no ${description} within ${timeoutMs}ms`));
            }, timeoutMs);
            const waiter: Waiter = {
              accepts,
              resolve: (message) => {
                clearTimeout(timer);
                done(message);
              },
            };
            waiters.push(waiter);
          }),
      }),
    );
  });

const isReply = (message: ServerMessage): boolean => message.type === "welcome" || message.type === "error";

const toBot = (wire: Wire, nickname: string, playerId: string): Bot => ({
  nickname,
  playerId,
  send: wire.send,
  latest: () => {
    const state = wire.lastState();
    if (!state) throw new Error(`${nickname} has no room state yet`);
    return state;
  },
  waitForState: async (description, accepts, timeoutMs) => {
    const current = wire.lastState();
    if (current && accepts(current)) return current;
    const message = await wire.next(description, (m) => m.type === "state" && accepts(m.state), timeoutMs);
    if (message.type !== "state") throw new Error(`${nickname}: expected state while waiting for ${description}`);
    return message.state;
  },
  close: wire.close,
});

const welcomeOrThrow = (message: ServerMessage, nickname: string, room: string): Extract<ServerMessage, { type: "welcome" }> => {
  if (message.type === "welcome") return message;
  if (message.type === "error") throw new Error(`${nickname} could not join room ${room}: ${message.code} (${message.message})`);
  throw new Error(`${nickname} expected a welcome from room ${room}, got ${message.type}`);
};

const remember = (secrets: SecretBook, nickname: string, token: string | undefined): void => {
  if (token === undefined) throw new Error(`The room server gave ${nickname} no reconnect token`);
  secrets.add(`reconnect token of ${nickname}`, token);
};

export const randomRoomCode = (): string =>
  Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)] ?? "A").join("");

export const createRoomAsHost = async (host: string, nickname: string, secrets: SecretBook): Promise<{ room: string; bot: Bot }> => {
  for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt += 1) {
    const room = randomRoomCode();
    const wire = await openWire(host, room, nickname);
    wire.send({ type: "join", nickname, create: true });
    const reply = await wire.next("reply to create", isReply);
    if (reply.type === "error" && reply.code === "room_exists") {
      wire.close();
      continue;
    }
    const welcome = welcomeOrThrow(reply, nickname, room);
    remember(secrets, nickname, welcome.reconnectToken);
    return { room, bot: toBot(wire, nickname, welcome.playerId) };
  }
  throw new Error(`Could not create a room after ${CREATE_ATTEMPTS} attempts; every code was taken.`);
};

export const joinAsPlayer = async (host: string, room: string, nickname: string, secrets: SecretBook): Promise<Bot> => {
  const wire = await openWire(host, room, nickname);
  wire.send({ type: "join", nickname });
  const welcome = welcomeOrThrow(await wire.next("reply to join", isReply), nickname, room);
  remember(secrets, nickname, welcome.reconnectToken);
  return toBot(wire, nickname, welcome.playerId);
};
