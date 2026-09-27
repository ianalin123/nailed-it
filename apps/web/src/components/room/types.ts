import type { ClientMessage, RoomState } from "@nailed-it/protocol";

export type ViewProps = {
  room: RoomState;
  viewerId: string | undefined;
  send: (message: ClientMessage) => void;
};
