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
};

export const DEFAULT_TIMING: MockTiming = {
  connectMs: 400,
  guessMinMs: 1200,
  guessSpreadMs: 3500,
  revealAfterVotesMs: 1800,
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
  const botIds = new Map<string, MockBot>();
  const pendingBotActions = new Set<string>();
  let game: MockGame = createMockGame(room);
  let status: SocketStatus = "connecting";
  let userId: string | undefined;
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

  const deliver = (message: ServerMessage): void => {
    listeners.emit({ kind: "message", data: JSON.stringify(message) });
  };

  const broadcast = (): void => {
    deliver({ type: "state", state: toRoomState(game) });
    scheduleBots();
  };

  const botAct = (botId: string, message: ClientMessage): void => {
    const outcome = applyMessage(game, botId, message, newId);
    if (!outcome.ok) return;
    game = outcome.game;
    broadcast();
  };

  const scheduleOnce = (key: string, ms: number, task: () => void): void => {
    if (pendingBotActions.has(key)) return;
    pendingBotActions.add(key);
    later(ms, () => {
      pendingBotActions.delete(key);
      task();
    });
  };

  const scheduleBots = (): void => {
    const round = game.round;
    if (game.status !== "playing" || !round || round.truth !== undefined) return;
    const readId = round.card.read.id;
    for (const botId of botIds.keys()) {
      if (botId === round.card.hotSeatId || round.guesses[botId]) continue;
      const guess: Guess = random() < 0.55 ? "nailed" : "off";
      const delay = timing.guessMinMs + random() * timing.guessSpreadMs;
      scheduleOnce(`guess:${readId}:${botId}`, delay, () => botAct(botId, { type: "guess", readId, guess }));
    }
    const hotSeatBot = botIds.has(round.card.hotSeatId);
    const guesserCount = game.players.filter((player) => player.id !== round.card.hotSeatId).length;
    const allVoted = Object.keys(round.guesses).length >= guesserCount;
    if (hotSeatBot && allVoted) {
      const truth = pickTruth(round.card.read.confidence, random());
      scheduleOnce(`reveal:${readId}`, timing.revealAfterVotesMs, () =>
        botAct(round.card.hotSeatId, { type: "reveal", readId, truth }),
      );
    }
  };

  const startBots = (): void => {
    if (botsStarted) return;
    botsStarted = true;
    for (const bot of bots) {
      later(bot.joinAfterMs, () => {
        const outcome = applyMessage(game, undefined, { type: "join", nickname: bot.nickname }, newId);
        if (!outcome.ok || !outcome.joined) return;
        const botId = outcome.joined.playerId;
        game = outcome.game;
        botIds.set(botId, bot);
        broadcast();
        if (bot.deckAfterMs !== undefined) {
          later(bot.deckAfterMs, () => botAct(botId, { type: "submit_deck", deck: buildDemoDeck(botId) }));
        }
      });
    }
  };

  const setStatus = (next: SocketStatus): void => {
    status = next;
    listeners.emit({ kind: "status", status: next });
  };

  later(timing.connectMs, () => setStatus("open"));

  return {
    send(message) {
      if (status !== "open") return { ok: false, reason: "Not connected to the room right now." };
      later(0, () => {
        const outcome = applyMessage(game, userId, message, newId);
        if (!outcome.ok) {
          deliver({ type: "error", code: outcome.error.code, message: outcome.error.message });
          return;
        }
        game = outcome.game;
        if (message.type === "join" && outcome.joined) {
          userId = outcome.joined.playerId;
          deliver({
            type: "welcome",
            playerId: userId,
            reconnectToken: outcome.joined.token,
            state: toRoomState(game),
          });
          startBots();
          scheduleBots();
          return;
        }
        broadcast();
      });
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
