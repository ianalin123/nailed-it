import { act, renderHook } from "@testing-library/react";
import type { ClientMessage } from "@nailed-it/protocol";
import { makeState } from "@/test/fixtures";
import { loadSeat } from "./identity";
import type { RoomTransport, SocketStatus, TransportListener } from "./transport";
import { useRoom, type OpenTransport } from "./useRoom";

type FakeTransport = RoomTransport & {
  sent: ClientMessage[];
  setStatus: (status: SocketStatus) => void;
  deliver: (data: unknown) => void;
  closed: boolean;
};

const fakeTransport = (): FakeTransport => {
  const listeners = new Set<TransportListener>();
  let status: SocketStatus = "connecting";
  const fake: FakeTransport = {
    sent: [],
    closed: false,
    send(message) {
      if (status !== "open") return { ok: false, reason: "offline" };
      fake.sent.push(message);
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ kind: "status", status });
      return () => listeners.delete(listener);
    },
    close() {
      fake.closed = true;
    },
    setStatus(next) {
      status = next;
      listeners.forEach((listener) => listener({ kind: "status", status: next }));
    },
    deliver(data) {
      listeners.forEach((listener) => listener({ kind: "message", data }));
    },
  };
  return fake;
};

const setup = () => {
  const transport = fakeTransport();
  const open: OpenTransport = () => ({ ok: true, transport });
  const hook = renderHook(() => useRoom("ABCD", { role: "player", nickname: "Ada", create: false }, open));
  return { transport, hook };
};

describe("useRoom", () => {
  it("joins on open, stores the seat from welcome, and rejoins with it after a drop", () => {
    const { transport, hook } = setup();
    expect(hook.result.current.session.connection).toBe("connecting");

    act(() => transport.setStatus("open"));
    expect(transport.sent).toEqual([{ type: "join", nickname: "Ada" }]);

    const welcome = { type: "welcome", playerId: "p1", reconnectToken: "secret", state: makeState() };
    act(() => transport.deliver(JSON.stringify(welcome)));
    expect(hook.result.current.session.playerId).toBe("p1");
    expect(loadSeat("ABCD")).toEqual({ ok: true, value: { playerId: "p1", token: "secret" } });

    act(() => transport.setStatus("connecting"));
    expect(hook.result.current.session.connection).toBe("reconnecting");

    act(() => transport.setStatus("open"));
    expect(transport.sent.at(-1)).toEqual({ type: "join", nickname: "Ada", playerId: "p1", token: "secret" });
  });

  it("keeps the stored token when a rejoin welcome omits it", () => {
    const { transport } = setup();
    act(() => transport.setStatus("open"));
    act(() => transport.deliver(JSON.stringify({ type: "welcome", playerId: "p1", reconnectToken: "secret", state: makeState() })));
    act(() => transport.setStatus("connecting"));
    act(() => transport.setStatus("open"));
    act(() => transport.deliver(JSON.stringify({ type: "welcome", playerId: "p1", state: makeState() })));
    expect(loadSeat("ABCD")).toEqual({ ok: true, value: { playerId: "p1", token: "secret" } });
  });

  it("drops a rejected seat and joins fresh once, with a visible notice", () => {
    const { transport, hook } = setup();
    act(() => transport.setStatus("open"));
    act(() => transport.deliver(JSON.stringify({ type: "welcome", playerId: "p1", reconnectToken: "secret", state: makeState() })));
    act(() => transport.setStatus("connecting"));
    act(() => transport.setStatus("open"));
    const badToken = JSON.stringify({ type: "error", code: "bad_token", message: "No." });
    act(() => transport.deliver(badToken));
    act(() => transport.deliver(badToken));
    expect(transport.sent.slice(-2)).toEqual([
      { type: "join", nickname: "Ada", playerId: "p1", token: "secret" },
      { type: "join", nickname: "Ada" },
    ]);
    expect(loadSeat("ABCD")).toEqual({ ok: true, value: undefined });
    expect(hook.result.current.session.notices[0]?.title).toBe("Couldn't reclaim your seat");
  });

  it("surfaces unparseable messages and server errors as notices", () => {
    const { transport, hook } = setup();
    act(() => transport.setStatus("open"));
    act(() => transport.deliver("not json"));
    act(() => transport.deliver(JSON.stringify({ type: "error", code: "wrong_phase", message: "Too late." })));
    const titles = hook.result.current.session.notices.map((notice) => notice.title);
    expect(titles).toEqual(["Received a message this app can't read", "That can't happen right now"]);
  });

  it("surfaces a failed send instead of dropping it", () => {
    const { transport, hook } = setup();
    act(() => hook.result.current.send({ type: "next" }));
    expect(transport.sent).toEqual([]);
    expect(hook.result.current.session.notices[0]?.title).toBe("That didn't send");
  });

  it("explains a missing server configuration", () => {
    const open: OpenTransport = () => ({ ok: false, reason: "No host." });
    const { result } = renderHook(() => useRoom("ABCD", { role: "player", nickname: "Ada", create: false }, open));
    expect(result.current.session.connection).toBe("closed");
    expect(result.current.session.notices[0]).toMatchObject({ title: "No room server configured", detail: "No host." });
  });

  it("creates once, then rejoins without the create flag after a drop", () => {
    const transport = fakeTransport();
    const open: OpenTransport = () => ({ ok: true, transport });
    renderHook(() => useRoom("ABCD", { role: "player", nickname: "Ada", create: true }, open));
    act(() => transport.setStatus("open"));
    expect(transport.sent[0]).toEqual({ type: "join", nickname: "Ada", create: true });
    window.localStorage.clear();
    act(() => transport.deliver(JSON.stringify({ type: "welcome", playerId: "p1", state: makeState() })));
    window.localStorage.clear();
    act(() => transport.setStatus("connecting"));
    act(() => transport.setStatus("open"));
    expect(transport.sent.at(-1)).toEqual({ type: "join", nickname: "Ada" });
  });

  it("reports room_not_found as a join failure, not a toast", () => {
    const { transport, hook } = setup();
    act(() => transport.setStatus("open"));
    act(() => transport.deliver(JSON.stringify({ type: "error", code: "room_not_found", message: "No room ABCD." })));
    expect(hook.result.current.session.joinFailure).toEqual({ code: "room_not_found", message: "No room ABCD." });
    expect(hook.result.current.session.notices).toEqual([]);
  });

  it("joins as a stage without reading or writing a seat", () => {
    const transport = fakeTransport();
    const open: OpenTransport = () => ({ ok: true, transport });
    window.localStorage.setItem("nailed-it:seat:ABCD", JSON.stringify({ playerId: "p1", token: "secret" }));
    renderHook(() => useRoom("ABCD", { role: "stage" }, open));
    act(() => transport.setStatus("open"));
    expect(transport.sent).toEqual([{ type: "join", nickname: "Stage", role: "stage" }]);
    act(() => transport.deliver(JSON.stringify({ type: "welcome", playerId: "stage-1", state: makeState() })));
    expect(loadSeat("ABCD")).toEqual({ ok: true, value: { playerId: "p1", token: "secret" } });
  });

  it("closes the transport on unmount", () => {
    const { transport, hook } = setup();
    hook.unmount();
    expect(transport.closed).toBe(true);
  });
});
