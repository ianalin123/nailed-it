import type { RoomState, ServerMessage } from "@nailed-it/protocol";
import { buildDemoDeck } from "@/lib/game/demoDeck";
import { decodeServerMessage } from "../messages";
import type { RoomTransport, TransportEvent } from "../transport";
import { createMockTransport, DEFAULT_BOTS, mockScenarioFor } from "./mockTransport";

const collect = (transport: RoomTransport) => {
  const messages: ServerMessage[] = [];
  const statuses: string[] = [];
  transport.subscribe((event: TransportEvent) => {
    if (event.kind === "status") {
      statuses.push(event.status);
      return;
    }
    const decoded = decodeServerMessage(event.data);
    if (!decoded.ok) throw new Error(decoded.detail);
    messages.push(decoded.message);
  });
  const latest = (): RoomState | undefined => {
    const withState = messages.flatMap((message) => (message.type === "error" ? [] : [message.state]));
    return withState.at(-1);
  };
  return { messages, statuses, latest };
};

describe("mock transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refuses to send before it is open", () => {
    const transport = createMockTransport({ room: "ABCD" });
    expect(transport.send({ type: "join", nickname: "Ada" }).ok).toBe(false);
    transport.close();
  });

  it("simulates a full game with bots, every message schema-valid", () => {
    let roll = 0;
    const transport = createMockTransport({ room: "ABCD", random: () => ((roll += 0.37) % 1) });
    const feed = collect(transport);
    vi.advanceTimersByTime(500);
    expect(feed.statuses).toEqual(["connecting", "open"]);

    transport.send({ type: "join", nickname: "Ada", create: true });
    vi.advanceTimersByTime(1);
    const welcome = feed.messages[0];
    expect(welcome?.type === "welcome" && welcome.reconnectToken).toBeTruthy();
    expect(welcome?.type).toBe("welcome");
    const me = welcome?.type === "welcome" ? welcome.playerId : "";

    transport.send({ type: "submit_deck", deck: buildDemoDeck("me") });
    vi.advanceTimersByTime(10_000);
    const lobby = feed.latest();
    expect(lobby?.players).toHaveLength(1 + DEFAULT_BOTS.length);
    expect(lobby?.players.filter((player) => player.hasDeck)).toHaveLength(3);
    expect(lobby?.players.find((player) => player.id === me)?.isHost).toBe(true);

    transport.send({ type: "start", cardsPerPlayer: 2 });
    vi.advanceTimersByTime(1);

    for (let step = 0; step < 50 && feed.latest()?.status === "playing"; step += 1) {
      const round = feed.latest()?.round;
      if (!round) break;
      if (round.phase === "voting" && round.hotSeatPlayerId === me) {
        vi.advanceTimersByTime(6000);
        transport.send({ type: "reveal", readId: round.read.id, truth: "nailed" });
      } else if (round.phase === "voting") {
        transport.send({ type: "guess", readId: round.read.id, guess: "nailed" });
        vi.advanceTimersByTime(10_000);
      } else {
        transport.send({ type: "next" });
      }
      vi.advanceTimersByTime(1);
    }

    const final = feed.latest();
    expect(final?.status).toBe("finished");
    expect(final?.readerAccuracy).toBeDefined();
    expect(feed.messages.filter((message) => message.type === "error")).toEqual([]);
    transport.close();
  });

  it("plays a whole bot-hosted game on its own for a stage", () => {
    const transport = createMockTransport({ room: "KQRT" });
    const feed = collect(transport);
    vi.advanceTimersByTime(500);
    transport.send({ type: "join", nickname: "Stage", role: "stage" });
    vi.advanceTimersByTime(1);
    expect(feed.messages[0]).toMatchObject({ type: "welcome" });
    expect(feed.messages[0]?.type === "welcome" && feed.messages[0].reconnectToken).toBeUndefined();
    vi.advanceTimersByTime(10 * 60_000);
    expect(feed.latest()?.status).toBe("finished");
    const sawChain = feed.messages.some((message) => message.type !== "error" && message.state.round?.chain);
    expect(sawChain).toBe(true);
    expect(feed.messages.filter((message) => message.type === "error")).toEqual([]);
    transport.close();
  });

  it("refuses to join a missing room and to create a taken one", () => {
    const missing = createMockTransport({ room: "XQRT" });
    const missingFeed = collect(missing);
    const taken = createMockTransport({ room: "YQRT" });
    const takenFeed = collect(taken);
    vi.advanceTimersByTime(500);
    missing.send({ type: "join", nickname: "Ada" });
    taken.send({ type: "join", nickname: "Ada", create: true });
    vi.advanceTimersByTime(1);
    expect(missingFeed.messages[0]).toMatchObject({ type: "error", code: "room_not_found" });
    expect(takenFeed.messages[0]).toMatchObject({ type: "error", code: "room_exists" });
    missing.close();
    taken.close();
  });

  it("maps codes to scenarios", () => {
    expect(mockScenarioFor("ABCD", true)).toBe("new");
    expect(mockScenarioFor("ABCD", false)).toBe("existing");
    expect(mockScenarioFor("XBCD", false)).toBe("missing");
    expect(mockScenarioFor("YBCD", true)).toBe("existing");
  });

  it("returns protocol errors for rule violations", () => {
    const transport = createMockTransport({ room: "ABCD", bots: [] });
    const feed = collect(transport);
    vi.advanceTimersByTime(500);
    transport.send({ type: "join", nickname: "Ada", create: true });
    transport.send({ type: "start", cardsPerPlayer: 3 });
    vi.advanceTimersByTime(1);
    expect(feed.messages.at(-1)).toMatchObject({ type: "error", code: "not_enough_players" });
    transport.close();
  });
});
