export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const STORAGE_UNAVAILABLE =
  "This browser won't let the game save anything, so it can't remember you if you reload.";

export const browserStore = (): StoreResult<KeyValueStore> => {
  try {
    if (typeof window === "undefined") return { ok: false, reason: "No browser storage on the server." };
    const storage = window.localStorage;
    return { ok: true, value: storage };
  } catch (error) {
    return { ok: false, reason: `${STORAGE_UNAVAILABLE} (${describe(error)})` };
  }
};

const read = (store: StoreResult<KeyValueStore>, key: string): StoreResult<string | undefined> => {
  if (!store.ok) return store;
  try {
    return { ok: true, value: store.value.getItem(key) ?? undefined };
  } catch (error) {
    return { ok: false, reason: `${STORAGE_UNAVAILABLE} (${describe(error)})` };
  }
};

const write = (store: StoreResult<KeyValueStore>, key: string, value: string): StoreResult<void> => {
  if (!store.ok) return store;
  try {
    store.value.setItem(key, value);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, reason: `${STORAGE_UNAVAILABLE} (${describe(error)})` };
  }
};

export type SeatIdentity = { playerId: string; token: string | undefined };

export const seatKey = (roomCode: string): string => `nailed-it:seat:${roomCode}`;
export const NICKNAME_KEY = "nailed-it:nickname";

const UNREADABLE_SEAT = "Your saved seat for this room was unreadable, so you'll join as a new player.";

const parseJson = (raw: string): StoreResult<unknown> => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, reason: `${UNREADABLE_SEAT} (${describe(error)})` };
  }
};

export const parseSeat = (raw: string): StoreResult<SeatIdentity | undefined> => {
  if (raw === "") return { ok: true, value: undefined };
  const json = parseJson(raw);
  if (!json.ok) return json;
  const record = typeof json.value === "object" && json.value !== null ? (json.value as Record<string, unknown>) : {};
  if (typeof record.playerId !== "string" || record.playerId.length === 0) {
    return { ok: false, reason: UNREADABLE_SEAT };
  }
  return {
    ok: true,
    value: { playerId: record.playerId, token: typeof record.token === "string" ? record.token : undefined },
  };
};

export const loadSeat = (roomCode: string, store = browserStore()): StoreResult<SeatIdentity | undefined> => {
  const raw = read(store, seatKey(roomCode));
  if (!raw.ok) return raw;
  return raw.value === undefined ? { ok: true, value: undefined } : parseSeat(raw.value);
};

export const saveSeat = (roomCode: string, seat: SeatIdentity, store = browserStore()) =>
  write(store, seatKey(roomCode), JSON.stringify(seat));

export const clearSeat = (roomCode: string, store = browserStore()) => write(store, seatKey(roomCode), "");

export const loadNickname = (store = browserStore()) => read(store, NICKNAME_KEY);

export const saveNickname = (nickname: string, store = browserStore()) => write(store, NICKNAME_KEY, nickname);
