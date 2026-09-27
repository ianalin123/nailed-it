import { createMockTransport } from "./mock/mockTransport";
import { createPartyTransport } from "./partyTransport";
import type { RoomConfig } from "./config";
import type { RoomTransport } from "./transport";

export type TransportChoice = { ok: true; transport: RoomTransport } | { ok: false; reason: string };

export const createTransport = (config: RoomConfig, room: string): TransportChoice => {
  switch (config.mode) {
    case "mock":
      return { ok: true, transport: createMockTransport({ room }) };
    case "party":
      return { ok: true, transport: createPartyTransport({ host: config.host, room, party: config.party }) };
    case "unconfigured":
      return { ok: false, reason: config.reason };
  }
};
