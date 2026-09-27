import type { ErrorCode, RoomState, ServerMessage } from "@nailed-it/protocol";
import type { SocketStatus } from "./transport";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export type Notice = { id: number; title: string; detail: string };

export type JoinFailure = { code: "room_not_found" | "room_exists"; message: string };

export type RoomSession = {
  connection: ConnectionState;
  hasConnected: boolean;
  room: RoomState | undefined;
  playerId: string | undefined;
  joinFailure: JoinFailure | undefined;
  notices: Notice[];
  nextNoticeId: number;
};

export type SessionAction =
  | { type: "socket_status"; status: SocketStatus }
  | { type: "server_message"; message: ServerMessage }
  | { type: "decode_failed"; detail: string }
  | { type: "notice"; title: string; detail: string }
  | { type: "dismiss_notice"; id: number };

export const MAX_NOTICES = 4;

export const initialSession = (playerId?: string): RoomSession => ({
  connection: "connecting",
  hasConnected: false,
  room: undefined,
  playerId,
  joinFailure: undefined,
  notices: [],
  nextNoticeId: 1,
});

export const SERVER_ERROR_TITLE: Record<ErrorCode, string> = {
  invalid_message: "The room rejected that action",
  room_full: "This room is full",
  not_host: "Only the host can do that",
  not_hot_seat: "Only the player in the hot seat can reveal",
  wrong_phase: "That can't happen right now",
  not_enough_players: "Not enough players yet",
  not_enough_decks: "Not enough decks yet",
  unknown_read: "That card is no longer in play",
  bad_token: "Couldn't reclaim your seat",
  room_not_found: "There's no room with that code",
  room_exists: "That room code is already taken",
  not_joined: "You're not in this room yet",
  hot_seat_cannot_guess: "You can't guess on your own card",
  stage_cannot_act: "The big screen only watches",
};

const JOIN_FAILURES = new Set<ErrorCode>(["room_not_found", "room_exists"]);

const connectionFor = (status: SocketStatus, hasConnected: boolean): ConnectionState => {
  if (status === "open") return "open";
  if (status === "closed") return "closed";
  return hasConnected ? "reconnecting" : "connecting";
};

const isShowing = (session: RoomSession, title: string, detail: string): boolean =>
  session.notices.some((notice) => notice.title === title && notice.detail === detail);

const pushNotice = (session: RoomSession, title: string, detail: string): RoomSession => {
  if (isShowing(session, title, detail)) return session;
  return {
    ...session,
    notices: [...session.notices, { id: session.nextNoticeId, title, detail }].slice(-MAX_NOTICES),
    nextNoticeId: session.nextNoticeId + 1,
  };
};

const applyServerMessage = (session: RoomSession, message: ServerMessage): RoomSession => {
  switch (message.type) {
    case "welcome":
      return { ...session, playerId: message.playerId, room: message.state, joinFailure: undefined };
    case "state":
      return { ...session, room: message.state };
    case "error":
      if (JOIN_FAILURES.has(message.code) && !session.room) {
        const code = message.code === "room_exists" ? "room_exists" : "room_not_found";
        return { ...session, joinFailure: { code, message: message.message } };
      }
      return pushNotice(session, SERVER_ERROR_TITLE[message.code], message.message);
  }
};

export const sessionReducer = (session: RoomSession, action: SessionAction): RoomSession => {
  switch (action.type) {
    case "socket_status": {
      const hasConnected = session.hasConnected || action.status === "open";
      return { ...session, hasConnected, connection: connectionFor(action.status, session.hasConnected) };
    }
    case "server_message":
      return applyServerMessage(session, action.message);
    case "decode_failed":
      return pushNotice(session, "Received a message this app can't read", action.detail);
    case "notice":
      return pushNotice(session, action.title, action.detail);
    case "dismiss_notice":
      return { ...session, notices: session.notices.filter((notice) => notice.id !== action.id) };
  }
};

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
};
