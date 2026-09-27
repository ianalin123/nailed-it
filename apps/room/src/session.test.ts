import { ServerMessage, type ServerMessage as ServerMessageType } from "@nailed-it/protocol";
import { describe, expect, it } from "vitest";
import { MAX_PLAYERS } from "@nailed-it/protocol";
import { chainTextFor, makeDeck } from "./game/fixtures.test-helpers";
import { createSession, handleClose, handleMessage, type Outbound, type Session, type SessionDeps } from "./session";

const deps = (): SessionDeps => {
  let counter = 0;
  let tokens = 0;
  return {
    newPlayerId: () => `generated-${(counter += 1)}`,
    newToken: () => `token-${(tokens += 1)}`,
    random: () => 0,
    now: () => "2026-09-27T12:00:00.000Z",
  };
};

const sendsTo = (outbound: readonly Outbound[], connectionId: string): ServerMessageType[] =>
  outbound.flatMap((o) => (o.kind === "send" && o.connectionId === connectionId ? [o.message] : []));

const run = (
  session: Session,
  connectionId: string,
  message: unknown,
  d: SessionDeps,
): { session: Session; outbound: readonly Outbound[] } =>
  handleMessage(session, connectionId, typeof message === "string" ? message : JSON.stringify(message), d);

describe("session", () => {
  it("rejects malformed JSON and schema-invalid messages with invalid_message", () => {
    const d = deps();
    const session = createSession("ABCD");
    for (const raw of ["{nope", JSON.stringify({ type: "dance" }), JSON.stringify({ type: "join", nickname: "" })]) {
      const { outbound } = handleMessage(session, "c1", raw, d);
      expect(sendsTo(outbound, "c1")).toEqual([
        expect.objectContaining({ type: "error", code: "invalid_message" }),
      ]);
    }
  });

  it("rejects non-join messages from a connection that has not joined with not_joined", () => {
    const { outbound } = run(createSession("ABCD"), "c1", { type: "next" }, deps());
    expect(sendsTo(outbound, "c1")[0]).toMatchObject({ type: "error", code: "not_joined" });
  });

  it("welcomes a joiner with a generated id and broadcasts state to the others", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    const welcome = sendsTo(step.outbound, "c1")[0];
    expect(welcome).toMatchObject({ type: "welcome", playerId: "generated-1" });
    expect(ServerMessage.safeParse(welcome).success).toBe(true);

    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    expect(sendsTo(step.outbound, "c2")[0]).toMatchObject({ type: "welcome", playerId: "generated-2" });
    const toFirst = sendsTo(step.outbound, "c1");
    expect(toFirst).toHaveLength(1);
    expect(toFirst[0]?.type).toBe("state");
  });

  it("reconnects a returning playerId on a new connection", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    step = handleClose(step.session, "c1");
    const afterClose = sendsTo(step.outbound, "c2")[0];
    expect(afterClose?.type === "state" && afterClose.state.players[0]?.connected).toBe(false);

    step = run(step.session, "c3", { type: "join", nickname: "Ana", playerId: "generated-1", token: "token-1" }, d);
    const welcome = sendsTo(step.outbound, "c3")[0];
    expect(welcome).toMatchObject({ type: "welcome", playerId: "generated-1" });
    expect(welcome?.type === "welcome" && welcome.state.players[0]?.connected).toBe(true);
  });

  it("keeps a player connected while another of their connections is open", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Ana", playerId: "generated-1", token: "token-1" }, d);
    step = handleClose(step.session, "c1");
    expect(step.session.state.players[0]?.connected).toBe(true);
    step = handleClose(step.session, "c2");
    expect(step.session.state.players[0]?.connected).toBe(false);
  });

  it("rejects joining as a second player on an already-joined connection", () => {
    const d = deps();
    const step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    const again = run(step.session, "c1", { type: "join", nickname: "Other", playerId: "someone-else" }, d);
    expect(sendsTo(again.outbound, "c1")[0]).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("forwards reducer errors only to the offending connection", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    const bad = run(step.session, "c2", { type: "start", cardsPerPlayer: 1 }, d);
    expect(sendsTo(bad.outbound, "c2")).toEqual([expect.objectContaining({ type: "error", code: "not_host" })]);
    expect(sendsTo(bad.outbound, "c1")).toEqual([]);
  });

  it("plays a round end to end and emits a persist_verdict outbound on reveal", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    step = run(step.session, "c1", { type: "submit_deck", deck: makeDeck("ana") }, d);
    step = run(step.session, "c2", { type: "submit_deck", deck: makeDeck("bo") }, d);
    step = run(step.session, "c1", { type: "start", cardsPerPlayer: 1 }, d);
    const state = step.session.state;
    const readId = state.schedule[0]?.read.id ?? "";
    step = run(step.session, "c2", { type: "guess", readId, guess: "nailed" }, d);
    step = run(step.session, "c1", { type: "reveal", readId, truth: "nailed" }, d);
    const persisted = step.outbound.filter((o) => o.kind === "persist_verdict");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "persist_verdict", sequence: 0 });
    for (const connectionId of ["c1", "c2"]) {
      const message = sendsTo(step.outbound, connectionId)[0];
      expect(ServerMessage.safeParse(message).success).toBe(true);
      expect(message?.type === "state" && message.state.round?.truth).toBe("nailed");
    }
  });

  it("issues a reconnect token only in the welcome, never in broadcast state", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    expect(sendsTo(step.outbound, "c1")[0]).toMatchObject({ type: "welcome", reconnectToken: "token-1" });
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    step = run(step.session, "c1", { type: "submit_deck", deck: makeDeck("ana") }, d);
    const everything = JSON.stringify(step.outbound);
    expect(everything).not.toContain("token-1");
    expect(everything).not.toContain("token-2");
    expect(JSON.stringify(sendsTo(run(step.session, "c3", { type: "join", nickname: "Cy" }, d).outbound, "c3"))).not.toContain(
      "token-1",
    );
  });

  it.each([
    ["no token", { type: "join", nickname: "Mallory", playerId: "generated-1" }],
    ["a wrong token", { type: "join", nickname: "Mallory", playerId: "generated-1", token: "token-2" }],
    ["an unknown player id", { type: "join", nickname: "Mallory", playerId: "made-up", token: "token-1" }],
  ])("rejects taking over a player with %s", (_label, message) => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    const before = step.session;
    const attack = run(step.session, "c9", message, d);
    expect(sendsTo(attack.outbound, "c9")).toEqual([expect.objectContaining({ type: "error", code: "bad_token" })]);
    expect(attack.session).toBe(before);
    expect(sendsTo(attack.outbound, "c1")).toEqual([]);
  });

  it("restores tokens so a player can rejoin after a server restart", () => {
    const d = deps();
    const first = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
    const restored = createSession("ABCD", first.session.state, first.session.tokenByPlayer);
    const step = run(restored, "c5", { type: "join", nickname: "Ana", playerId: "generated-1", token: "token-1" }, d);
    expect(sendsTo(step.outbound, "c5")[0]).toMatchObject({ type: "welcome", playerId: "generated-1" });
  });

  describe("room creation", () => {
    it("rejects a plain join on a room that was never created", () => {
      const session = createSession("ABCD");
      const step = run(session, "c1", { type: "join", nickname: "Ana" }, deps());
      expect(sendsTo(step.outbound, "c1")).toEqual([expect.objectContaining({ type: "error", code: "room_not_found" })]);
      expect(step.session.state).toBe(session.state);
      expect(step.session.tokenByPlayer.size).toBe(0);
    });

    it("rejects create on a room that already has a player", () => {
      const d = deps();
      const step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
      const again = run(step.session, "c2", { type: "join", nickname: "Bo", create: true }, d);
      expect(sendsTo(again.outbound, "c2")).toEqual([expect.objectContaining({ type: "error", code: "room_exists" })]);
      expect(again.session.state).toBe(step.session.state);
      expect(again.session.tokenByPlayer).toBe(step.session.tokenByPlayer);
    });

    it("lets a player rejoin with their token regardless of create", () => {
      const d = deps();
      let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
      step = handleClose(step.session, "c1");
      step = run(step.session, "c2", { type: "join", nickname: "Ana", playerId: "generated-1", token: "token-1", create: true }, d);
      expect(sendsTo(step.outbound, "c2")[0]).toMatchObject({ type: "welcome", playerId: "generated-1" });
    });
  });

  describe("stage", () => {
    const withPlayers = (d: SessionDeps): Session => {
      let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d);
      step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
      return step.session;
    };

    it("is welcomed with state and no reconnect token, and is never a player", () => {
      const d = deps();
      const before = withPlayers(d);
      const step = run(before, "s1", { type: "join", nickname: "Stage", role: "stage" }, d);
      const welcome = sendsTo(step.outbound, "s1")[0];
      expect(ServerMessage.safeParse(welcome).success).toBe(true);
      expect(welcome?.type).toBe("welcome");
      expect(welcome).not.toHaveProperty("reconnectToken");
      expect(welcome?.type === "welcome" && welcome.state.players.map((p) => p.nickname)).toEqual(["Ana", "Bo"]);
      expect(step.session.state).toBe(before.state);
      expect(step.session.tokenByPlayer).toBe(before.tokenByPlayer);
      expect(sendsTo(step.outbound, "c1")).toEqual([]);
    });

    it("cannot create a room", () => {
      const session = createSession("ABCD");
      for (const create of [undefined, true]) {
        const step = run(session, "s1", { type: "join", nickname: "Stage", role: "stage", create }, deps());
        expect(sendsTo(step.outbound, "s1")).toEqual([expect.objectContaining({ type: "error", code: "room_not_found" })]);
        expect(step.session).toBe(session);
      }
    });

    it("receives every state broadcast, alongside other stages", () => {
      const d = deps();
      let step = run(withPlayers(d), "s1", { type: "join", nickname: "Stage", role: "stage" }, d);
      step = run(step.session, "s2", { type: "join", nickname: "Stage", role: "stage" }, d);
      step = run(step.session, "c1", { type: "submit_deck", deck: makeDeck("ana") }, d);
      for (const stage of ["s1", "s2"]) {
        const message = sendsTo(step.outbound, stage)[0];
        expect(message?.type === "state" && message.state.players[0]?.hasDeck).toBe(true);
      }
    });

    it.each([
      ["submit_deck", { type: "submit_deck", deck: makeDeck("stage") }],
      ["start", { type: "start", cardsPerPlayer: 1 }],
      ["guess", { type: "guess", readId: "ana-r0", guess: "nailed" }],
      ["reveal", { type: "reveal", readId: "ana-r0", truth: "nailed" }],
      ["next", { type: "next" }],
    ])("rejects %s with stage_cannot_act", (_label, message) => {
      const d = deps();
      const joined = run(withPlayers(d), "s1", { type: "join", nickname: "Stage", role: "stage" }, d).session;
      const step = run(joined, "s1", message, d);
      expect(sendsTo(step.outbound, "s1")).toEqual([expect.objectContaining({ type: "error", code: "stage_cannot_act" })]);
      expect(step.session).toBe(joined);
    });

    it("does not count toward MAX_PLAYERS and never becomes host", () => {
      const d = deps();
      let session = run(createSession("ABCD"), "s0", { type: "join", nickname: "Stage", role: "stage" }, d).session;
      session = run(session, "c0", { type: "join", nickname: "P0", create: true }, d).session;
      session = run(session, "s1", { type: "join", nickname: "Stage", role: "stage" }, d).session;
      for (let i = 1; i < MAX_PLAYERS; i += 1) {
        session = run(session, `c${i}`, { type: "join", nickname: `P${i}` }, d).session;
      }
      expect(session.state.players).toHaveLength(MAX_PLAYERS);
      session = handleClose(session, "c0").session;
      expect(session.state.hostId).toBe(session.state.players[1]?.id);
      const late = run(session, "s2", { type: "join", nickname: "Stage", role: "stage" }, d);
      expect(sendsTo(late.outbound, "s2")[0]?.type).toBe("welcome");
    });

    it("leaves quietly without touching game state", () => {
      const d = deps();
      const joined = run(withPlayers(d), "s1", { type: "join", nickname: "Stage", role: "stage" }, d).session;
      const step = handleClose(joined, "s1");
      expect(step.outbound).toEqual([]);
      expect(step.session.state).toBe(joined.state);
      const after = run(step.session, "c1", { type: "submit_deck", deck: makeDeck("ana") }, d);
      expect(sendsTo(after.outbound, "s1")).toEqual([]);
    });

    it("gets no yourGuess in its state", () => {
      const d = deps();
      let step = run(withPlayers(d), "s1", { type: "join", nickname: "Stage", role: "stage" }, d);
      step = run(step.session, "c1", { type: "submit_deck", deck: makeDeck("ana") }, d);
      step = run(step.session, "c1", { type: "start", cardsPerPlayer: 1 }, d);
      const readId = step.session.state.schedule[0]?.read.id ?? "";
      step = run(step.session, "c2", { type: "guess", readId, guess: "off" }, d);
      const toStage = sendsTo(step.outbound, "s1")[0];
      const toGuesser = sendsTo(step.outbound, "c2")[0];
      expect(toStage?.type === "state" && toStage.state.round).not.toHaveProperty("yourGuess");
      expect(toGuesser?.type === "state" && toGuesser.state.round?.yourGuess).toBe("off");
    });
  });

  it("sends no chain text and no other player's guess to anyone during voting", () => {
    const d = deps();
    const sent: Array<{ readonly outbound: Outbound; readonly viewer: string | undefined }> = [];
    const collect = (step: { session: Session; outbound: readonly Outbound[] }): Session => {
      for (const outbound of step.outbound) {
        const viewer = outbound.kind === "send" ? step.session.playerByConnection.get(outbound.connectionId) : undefined;
        sent.push({ outbound, viewer });
      }
      return step.session;
    };
    let session = collect(run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana", create: true }, d));
    session = collect(run(session, "c2", { type: "join", nickname: "Bo" }, d));
    session = collect(run(session, "c3", { type: "join", nickname: "Cy" }, d));
    session = collect(run(session, "s1", { type: "join", nickname: "Stage", role: "stage" }, d));
    session = collect(run(session, "c1", { type: "submit_deck", deck: makeDeck("ana") }, d));
    session = collect(run(session, "c1", { type: "start", cardsPerPlayer: 1 }, d));
    const readId = session.state.schedule[0]?.read.id ?? "";
    session = collect(run(session, "c2", { type: "guess", readId, guess: "off" }, d));
    session = collect(run(session, "c3", { type: "guess", readId, guess: "nailed" }, d));
    session = collect(run(session, "c4", { type: "join", nickname: "Dee" }, d));
    session = collect(run(session, "s2", { type: "join", nickname: "Stage", role: "stage" }, d));
    session = collect(handleClose(session, "c3"));
    session = collect(run(session, "c5", { type: "join", nickname: "Cy", playerId: "generated-3", token: "token-3" }, d));
    expect(session.state.round?.phase).toBe("voting");

    const serialized = JSON.stringify(sent.map(({ outbound }) => outbound));
    expect(serialized).not.toContain(chainTextFor(readId));
    expect(serialized).not.toContain('"chain"');
    for (const { outbound: o, viewer } of sent) {
      if (o.kind !== "send" || o.message.type === "error") continue;
      const round = o.message.state.round;
      if (!round) continue;
      expect(round).not.toHaveProperty("guesses");
      const own = viewer === undefined ? undefined : session.state.round?.guesses[viewer];
      if (round.yourGuess !== undefined) expect(round.yourGuess).toBe(own);
    }
    const toRejoined = sent.filter(({ outbound: o }) => o.kind === "send" && o.connectionId === "c5");
    expect(toRejoined[0]?.outbound).toMatchObject({ message: { type: "welcome", state: { round: { yourGuess: "nailed" } } } });

    const revealed = run(session, "c1", { type: "reveal", readId, truth: "nailed" }, d);
    expect(JSON.stringify(revealed.outbound)).toContain(chainTextFor(readId));
  });
});
