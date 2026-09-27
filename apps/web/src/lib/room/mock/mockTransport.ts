import type { ClientMessage, Guess, ServerMessage, Truth } from "@nailed-it/protocol";
import { buildDemoDeck } from "@/lib/game/demoDeck";
import { createListenerSet, type RoomTransport, type SocketStatus } from "../transport";
import { applyMessage, createMockGame, toRoomState, type MockGame } from "./mockGame";

export type MockBot = { nickname: string; joinAfterMs: number; deckAfterMs: number | undefined };

export const DEFAULT_BOTS: readonly MockBot[] = [
  { nickname: "Juno", joinAfterMs: 900, deckAfterMs: 2500 },
  { nickname: "Ravi", joinAfterMs: 1800, deckAfterMs: 5000 },
  { nickname: "Moss", joinAfterMs: 3200, deckAfterMs: undefined },
];

export type MockTiming = {
  connectMs: number;
  guessMinMs: number;
  guessSpreadMs: number;
  revealAfterVotesMs: number;
  revealDeadlineMs: number;
  hostStartMs: number;
  hostNextMs: number;
};

export const DEFAULT_TIMING: MockTiming = {
  connectMs: 400,
  guessMinMs: 1200,
  guessSpreadMs: 3500,
  revealAfterVotesMs: 1800,
  revealDeadlineMs: 14000,
  hostStartMs: 12000,
  hostNextMs: 9000,
};

export type MockScenario = "new" | "existing" | "missing";

// Codes starting with X never exist; codes starting with Y are always taken. Everything else
// is free to create, or already running with bot players if you join it without creating.
export const mockScenarioFor = (code: string, wantsToCreate: boolean): MockScenario => {
  if (code.startsWith("X")) return "missing";
  if (code.startsWith("Y")) return "existing";
  return wantsToCreate ? "new" : "existing";
};

export type MockTransportOptions = {
  room: string;
  bots?: readonly MockBot[];
  timing?: MockTiming;
  random?: () => number;
};

const pickTruth = (confidence: number, roll: number): Truth => {
  if (roll < confidence) return "nailed";
  if (roll < confidence + (1 - confidence) / 3) return "partly";
  return "off";
};

export const createMockTransport = ({
  room,
  bots = DEFAULT_BOTS,
  timing = DEFAULT_TIMING,
  random = Math.random,
}: MockTransportOptions): RoomTransport => {
  const listeners = createListenerSet();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const botIds = new Set<string>();
  const pendingBotActions = new Set<string>();
  let game: MockGame | undefined;
  let status: SocketStatus = "connecting";
  let viewerId: string | undefined;
  let idCounter = 0;
  let botsStarted = false;

  const newId = (): string => {
    idCounter += 1;
    return `mock-${idCounter}`;
  };

  const later = (ms: number, task: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      task();
    }, ms);
    timers.add(timer);
  };

  const scheduleOnce = (key: string, ms: number, task: () => void): void => {
    if (pendingBotActions.has(key)) return;
    pendingBotActions.add(key);
    later(ms, () => {
      pendingBotActions.delete(key);
      task();
    });
  };

  const deliver = (message: ServerMessage): void => {
    listeners.emit({ kind: "message", data: JSON.stringify(message) });
  };

  const broadcast = (): void => {
    if (!game) return;
    deliver({ type: "state", state: toRoomState(game, viewerId) });
    scheduleBots();
  };

  const tryBotAct = (botId: string, message: ClientMessage): void => {
    if (!game) return;
    const outcome = applyMessage(game, botId, message, newId);
    if (!outcome.ok) return;
    game = outcome.game;
    broadcast();
  };

  const addBot = (bot: MockBot, deckNow: boolean): void => {
    if (!game) return;
    const outcome = applyMessage(game, undefined, { type: "join", nickname: bot.nickname }, newId);
    if (!outcome.ok || !outcome.joined) return;
    const botId = outcome.joined.playerId;
    game = outcome.game;
    botIds.add(botId);
    if (deckNow && bot.deckAfterMs !== undefined) {
      const submitted = applyMessage(game, botId, { type: "submit_deck", deck: buildDemoDeck(botId) }, newId);
      if (submitted.ok) game = submitted.game;
      return;
    }
    if (bot.deckAfterMs !== undefined) {
      later(bot.deckAfterMs, () => tryBotAct(botId, { type: "submit_deck", deck: buildDemoDeck(botId) }));
    }
  };

  const botHostId = (): string | undefined => game?.players.find((player) => player.isHost && botIds.has(player.id))?.id;

  const scheduleHost = (): void => {
    const hostId = botHostId();
    if (!game || !hostId) return;
    const ready = game.players.length >= 2 && game.players.some((player) => player.hasDeck);
    if (game.status === "lobby" && ready) {
      scheduleOnce("host:start", timing.hostStartMs, () => tryBotAct(hostId, { type: "start", cardsPerPlayer: 2 }));
    }
    const round = game.round;
    if (game.status === "playing" && round && round.truth !== undefined) {
      scheduleOnce(`host:next:${round.card.read.id}`, timing.hostNextMs, () => tryBotAct(hostId, { type: "next" }));
    }
  };

  const scheduleBots = (): void => {
    scheduleHost();
    const round = game?.round;
    if (!game || game.status !== "playing" || !round || round.truth !== undefined) return;
    const readId = round.card.read.id;
    const hotSeatId = round.card.hotSeatId;
    for (const botId of botIds) {
      if (botId === hotSeatId || round.guesses[botId]) continue;
      const guess: Guess = random() < 0.55 ? "nailed" : "off";
      const delay = timing.guessMinMs + random() * timing.guessSpreadMs;
      scheduleOnce(`guess:${readId}:${botId}`, delay, () => tryBotAct(botId, { type: "guess", readId, guess }));
    }
    if (!botIds.has(hotSeatId)) return;
    const truth = pickTruth(round.card.read.confidence, random());
    const reveal = () => tryBotAct(hotSeatId, { type: "reveal", readId, truth });
    scheduleOnce(`reveal-deadline:${readId}`, timing.revealDeadlineMs, reveal);
    const guesserCount = game.players.filter((player) => player.id !== hotSeatId).length;
    if (Object.keys(round.guesses).length >= guesserCount) {
      scheduleOnce(`reveal:${readId}`, timing.revealAfterVotesMs, reveal);
    }
  };

  const startJoiningBots = (): void => {
    if (botsStarted) return;
    botsStarted = true;
    for (const bot of bots) {
      later(bot.joinAfterMs, () => {
        addBot(bot, false);
        broadcast();
      });
    }
  };

  const seedExistingRoom = (): void => {
    game = createMockGame(room, true);
    const [host, ...rest] = bots;
    if (host) addBot(host, true);
    const second = rest[0];
    if (second) addBot(second, true);
    botsStarted = true;
    for (const bot of rest.slice(1)) {
      later(bot.joinAfterMs, () => {
        addBot(bot, false);
        broadcast();
      });
    }
  };

  const prepareRoom = (message: ClientMessage): void => {
    if (game || message.type !== "join") return;
    const scenario = mockScenarioFor(room, message.create === true);
    if (scenario === "existing") seedExistingRoom();
    else game = createMockGame(room, false);
  };

  const handle = (message: ClientMessage): void => {
    prepareRoom(message);
    if (!game) return;
    const outcome = applyMessage(game, viewerId, message, newId);
    if (!outcome.ok) {
      deliver({ type: "error", code: outcome.error.code, message: outcome.error.message });
      return;
    }
    game = outcome.game;
    if (message.type === "join" && outcome.joined) {
      viewerId = outcome.joined.playerId;
      const token = outcome.joined.token;
      deliver({
        type: "welcome",
        playerId: viewerId,
        ...(token === undefined ? {} : { reconnectToken: token }),
        state: toRoomState(game, viewerId),
      });
      if (message.create === true) startJoiningBots();
      scheduleBots();
      return;
    }
    broadcast();
  };

  const setStatus = (next: SocketStatus): void => {
    status = next;
    listeners.emit({ kind: "status", status: next });
  };

  later(timing.connectMs, () => setStatus("open"));

  return {
    send(message) {
      if (status !== "open") return { ok: false, reason: "Not connected to the room right now." };
      later(0, () => handle(message));
      return { ok: true };
    },
    subscribe(listener) {
      const unsubscribe = listeners.add(listener);
      listener({ kind: "status", status });
      return unsubscribe;
    },
    close() {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      listeners.clear();
      status = "closed";
    },
  };
};
