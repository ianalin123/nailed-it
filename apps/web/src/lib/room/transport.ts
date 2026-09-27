import type { ClientMessage } from "@nailed-it/protocol";

export type SocketStatus = "connecting" | "open" | "closed";

export type TransportEvent =
  | { kind: "status"; status: SocketStatus }
  | { kind: "message"; data: unknown };

export type TransportListener = (event: TransportEvent) => void;

export type SendResult = { ok: true } | { ok: false; reason: string };

export interface RoomTransport {
  send(message: ClientMessage): SendResult;
  subscribe(listener: TransportListener): () => void;
  close(): void;
}

export type TransportFactory = (room: string) => RoomTransport;

export const createListenerSet = () => {
  const listeners = new Set<TransportListener>();
  return {
    add(listener: TransportListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: TransportEvent): void {
      listeners.forEach((listener) => listener(event));
    },
    clear(): void {
      listeners.clear();
    },
  };
};
