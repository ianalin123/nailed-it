import { clearSeat, loadNickname, loadSeat, saveNickname, saveSeat, seatKey, type KeyValueStore } from "./identity";

const memoryStore = (): { ok: true; value: KeyValueStore } => {
  const data = new Map<string, string>();
  return {
    ok: true,
    value: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    },
  };
};

const throwingStore: { ok: true; value: KeyValueStore } = {
  ok: true,
  value: {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  },
};

describe("player identity storage", () => {
  it("round-trips seats per room", () => {
    const store = memoryStore();
    const seat = { playerId: "p1", token: "t1" };
    expect(saveSeat("ABCD", seat, store)).toEqual({ ok: true, value: undefined });
    expect(loadSeat("ABCD", store)).toEqual({ ok: true, value: seat });
    expect(loadSeat("WXYZ", store)).toEqual({ ok: true, value: undefined });
  });

  it("treats a cleared seat as no seat", () => {
    const store = memoryStore();
    saveSeat("ABCD", { playerId: "p1", token: undefined }, store);
    clearSeat("ABCD", store);
    expect(loadSeat("ABCD", store)).toEqual({ ok: true, value: undefined });
  });

  it("reports a corrupt seat instead of guessing", () => {
    const store = memoryStore();
    store.value.setItem(seatKey("ABCD"), "{not json");
    expect(loadSeat("ABCD", store).ok).toBe(false);
    store.value.setItem(seatKey("ABCD"), JSON.stringify({ token: "t" }));
    expect(loadSeat("ABCD", store).ok).toBe(false);
  });

  it("round-trips the nickname", () => {
    const store = memoryStore();
    saveNickname("Ada", store);
    expect(loadNickname(store)).toEqual({ ok: true, value: "Ada" });
  });

  it("reports storage failures instead of throwing", () => {
    const read = loadSeat("ABCD", throwingStore);
    const write = saveSeat("ABCD", { playerId: "p1", token: undefined }, throwingStore);
    expect(read.ok).toBe(false);
    expect(write.ok).toBe(false);
    expect(!write.ok && write.reason).toContain("QuotaExceededError");
  });

  it("passes through an unavailable store", () => {
    expect(loadNickname({ ok: false, reason: "blocked" })).toEqual({ ok: false, reason: "blocked" });
  });

  it("uses real localStorage by default", () => {
    saveSeat("ABCD", { playerId: "p9", token: "t9" });
    expect(loadSeat("ABCD")).toEqual({ ok: true, value: { playerId: "p9", token: "t9" } });
  });
});
