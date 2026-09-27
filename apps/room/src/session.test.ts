import { ServerMessage, type ServerMessage as ServerMessageType } from "@nailed-it/protocol";
import { describe, expect, it } from "vitest";
import { makeDeck } from "./game/fixtures.test-helpers";
import { createSession, handleClose, handleMessage, type Outbound, type Session, type SessionDeps } from "./session";

const deps = (): SessionDeps => {
  let counter = 0;
  return {
    newPlayerId: () => `generated-${(counter += 1)}`,
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

  it("rejects non-join messages from a connection that has not joined", () => {
    const { outbound } = run(createSession("ABCD"), "c1", { type: "next" }, deps());
    expect(sendsTo(outbound, "c1")[0]).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("welcomes a joiner with a generated id and broadcasts state to the others", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana" }, d);
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
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana" }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    step = handleClose(step.session, "c1");
    const afterClose = sendsTo(step.outbound, "c2")[0];
    expect(afterClose?.type === "state" && afterClose.state.players[0]?.connected).toBe(false);

    step = run(step.session, "c3", { type: "join", nickname: "Ana", playerId: "generated-1" }, d);
    const welcome = sendsTo(step.outbound, "c3")[0];
    expect(welcome).toMatchObject({ type: "welcome", playerId: "generated-1" });
    expect(welcome?.type === "welcome" && welcome.state.players[0]?.connected).toBe(true);
  });

  it("keeps a player connected while another of their connections is open", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana" }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Ana", playerId: "generated-1" }, d);
    step = handleClose(step.session, "c1");
    expect(step.session.state.players[0]?.connected).toBe(true);
    step = handleClose(step.session, "c2");
    expect(step.session.state.players[0]?.connected).toBe(false);
  });

  it("rejects joining as a second player on an already-joined connection", () => {
    const d = deps();
    const step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana" }, d);
    const again = run(step.session, "c1", { type: "join", nickname: "Other", playerId: "someone-else" }, d);
    expect(sendsTo(again.outbound, "c1")[0]).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("forwards reducer errors only to the offending connection", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana" }, d);
    step = run(step.session, "c2", { type: "join", nickname: "Bo" }, d);
    const bad = run(step.session, "c2", { type: "start", cardsPerPlayer: 1 }, d);
    expect(sendsTo(bad.outbound, "c2")).toEqual([expect.objectContaining({ type: "error", code: "not_host" })]);
    expect(sendsTo(bad.outbound, "c1")).toEqual([]);
  });

  it("plays a round end to end and emits a persist_verdict outbound on reveal", () => {
    const d = deps();
    let step = run(createSession("ABCD"), "c1", { type: "join", nickname: "Ana" }, d);
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
});
