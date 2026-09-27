import { makeState } from "@/test/fixtures";
import { MAX_NOTICES, initialSession, sessionReducer } from "./session";

describe("sessionReducer", () => {
  it("starts connecting, then open", () => {
    const opened = sessionReducer(initialSession(), { type: "socket_status", status: "open" });
    expect(opened.connection).toBe("open");
    expect(opened.hasConnected).toBe(true);
  });

  it("reports reconnecting only after a first successful connection", () => {
    const first = sessionReducer(initialSession(), { type: "socket_status", status: "connecting" });
    expect(first.connection).toBe("connecting");
    const opened = sessionReducer(first, { type: "socket_status", status: "open" });
    const dropped = sessionReducer(opened, { type: "socket_status", status: "connecting" });
    expect(dropped.connection).toBe("reconnecting");
  });

  it("stores player id and state from welcome", () => {
    const state = makeState();
    const next = sessionReducer(initialSession(), {
      type: "server_message",
      message: { type: "welcome", playerId: "p1", state },
    });
    expect(next.playerId).toBe("p1");
    expect(next.room).toBe(state);
  });

  it("replaces room state on state messages and keeps the player id", () => {
    const welcomed = sessionReducer(initialSession(), {
      type: "server_message",
      message: { type: "welcome", playerId: "p1", state: makeState() },
    });
    const updated = makeState({ status: "finished" });
    const next = sessionReducer(welcomed, { type: "server_message", message: { type: "state", state: updated } });
    expect(next.room).toBe(updated);
    expect(next.playerId).toBe("p1");
  });

  it("turns server errors into visible notices", () => {
    const next = sessionReducer(initialSession(), {
      type: "server_message",
      message: { type: "error", code: "not_host", message: "Nope." },
    });
    expect(next.notices).toEqual([{ id: 1, title: "Only the host can do that", detail: "Nope." }]);
  });

  it("turns decode failures into visible notices", () => {
    const next = sessionReducer(initialSession(), { type: "decode_failed", detail: "bad" });
    expect(next.notices[0]).toMatchObject({ title: "Received a message this app can't read", detail: "bad" });
  });

  it("does not stack identical notices, caps the list, and dismisses by id", () => {
    let session = initialSession();
    session = sessionReducer(session, { type: "notice", title: "T", detail: "same" });
    session = sessionReducer(session, { type: "notice", title: "T", detail: "same" });
    expect(session.notices).toHaveLength(1);
    for (let index = 0; index < MAX_NOTICES + 2; index += 1) {
      session = sessionReducer(session, { type: "notice", title: "T", detail: `n${index}` });
    }
    expect(session.notices).toHaveLength(MAX_NOTICES);
    const firstId = session.notices[0]?.id ?? -1;
    session = sessionReducer(session, { type: "dismiss_notice", id: firstId });
    expect(session.notices.some((notice) => notice.id === firstId)).toBe(false);
  });
});
