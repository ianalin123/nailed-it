import { ROOM_PARTY } from "@nailed-it/protocol";
import PartySocket from "partysocket";
import type { ClientMessage } from "@nailed-it/protocol";
import { createListenerSet, type RoomTransport, type SocketStatus } from "./transport";

export type PartyTransportOptions = { host: string; room: string; party: string | undefined };

export const createPartyTransport = ({ host, room, party }: PartyTransportOptions): RoomTransport => {
  const listeners = createListenerSet();
  let status: SocketStatus = "connecting";
  let closedByUs = false;

  const setStatus = (next: SocketStatus): void => {
    status = next;
    listeners.emit({ kind: "status", status: next });
  };

  const socket = new PartySocket({
    host,
    room,
    party: party ?? ROOM_PARTY,
    maxEnqueuedMessages: 0,
  });

  socket.addEventListener("open", () => setStatus("open"));
  socket.addEventListener("close", () => setStatus(closedByUs ? "closed" : "connecting"));
  socket.addEventListener("message", (event: MessageEvent) => {
    listeners.emit({ kind: "message", data: event.data });
  });

  return {
    send(message: ClientMessage) {
      if (status !== "open") {
        return { ok: false, reason: "Not connected to the room right now. Try again once you're reconnected." };
      }
      socket.send(JSON.stringify(message));
      return { ok: true };
    },
    subscribe(listener) {
      const unsubscribe = listeners.add(listener);
      listener({ kind: "status", status });
      return unsubscribe;
    },
    close() {
      closedByUs = true;
      socket.close();
      listeners.clear();
    },
  };
};
