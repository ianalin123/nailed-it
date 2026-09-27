"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ClientMessage } from "@nailed-it/protocol";
import { readRoomEnv, resolveRoomConfig } from "./config";
import { createTransport, type TransportChoice } from "./createTransport";
import { clearSeat, loadSeat, saveSeat, type SeatIdentity } from "./identity";
import { joinMessageFor, shouldStoreSeat, type JoinPlan } from "./joinPlan";
import { decodeServerMessage } from "./messages";
import { initialSession, sessionReducer, type RoomSession } from "./session";
import type { RoomTransport, TransportEvent } from "./transport";

export type OpenTransport = (room: string) => TransportChoice;

const defaultOpenTransport: OpenTransport = (room) => createTransport(resolveRoomConfig(readRoomEnv()), room);

export type UseRoomResult = {
  session: RoomSession;
  send: (message: ClientMessage) => void;
  dismissNotice: (id: number) => void;
};


const IDENTITY_TITLE = "This device can't remember you";

const planFrom = (role: JoinPlan["role"], nickname: string, create: boolean): JoinPlan =>
  role === "stage" ? { role } : { role, nickname, create };

export const useRoom = (
  code: string,
  plan: JoinPlan,
  openTransport: OpenTransport = defaultOpenTransport,
): UseRoomResult => {
  const role = plan.role;
  const nickname = plan.role === "player" ? plan.nickname : "";
  const create = plan.role === "player" && plan.create;
  const [session, dispatch] = useReducer(sessionReducer, undefined, () => initialSession());
  const transportRef = useRef<RoomTransport | undefined>(undefined);

  const notice = useCallback(
    (title: string, detail: string) => dispatch({ type: "notice", title, detail }),
    [],
  );

  useEffect(() => {
    let joinPlan = planFrom(role, nickname, create);
    const storesSeat = shouldStoreSeat(joinPlan);
    const stopCreating = (): void => {
      if (joinPlan.role === "player") joinPlan = { ...joinPlan, create: false };
    };
    const choice = openTransport(code);
    if (!choice.ok) {
      dispatch({ type: "socket_status", status: "closed" });
      notice("No room server configured", choice.reason);
      return;
    }
    const transport = choice.transport;
    transportRef.current = transport;

    let lastSeat: SeatIdentity | undefined;
    let retriedFresh = false;

    const sendJoin = (seat: SeatIdentity | undefined): void => {
      lastSeat = seat;
      const result = transport.send(joinMessageFor(joinPlan, seat));
      if (!result.ok) notice("Couldn't join the room", result.reason);
    };

    const joinWithStoredSeat = (): void => {
      retriedFresh = false;
      if (!storesSeat) {
        sendJoin(undefined);
        return;
      }
      const stored = loadSeat(code);
      if (!stored.ok) notice(IDENTITY_TITLE, stored.reason);
      sendJoin(stored.ok ? stored.value : undefined);
    };

    const rememberSeat = (playerId: string, reconnectToken: string | undefined): void => {
      const token = reconnectToken ?? (lastSeat?.playerId === playerId ? lastSeat.token : undefined);
      const saved = saveSeat(code, { playerId, token });
      if (!saved.ok) notice(IDENTITY_TITLE, saved.reason);
    };

    const joinFreshAfterBadToken = (): void => {
      if (retriedFresh || lastSeat === undefined) return;
      retriedFresh = true;
      stopCreating();
      const cleared = clearSeat(code);
      if (!cleared.ok) notice(IDENTITY_TITLE, cleared.reason);
      sendJoin(undefined);
    };

    const handle = (event: TransportEvent): void => {
      if (event.kind === "status") {
        dispatch({ type: "socket_status", status: event.status });
        if (event.status === "open") joinWithStoredSeat();
        return;
      }
      const decoded = decodeServerMessage(event.data);
      if (!decoded.ok) {
        dispatch({ type: "decode_failed", detail: decoded.detail });
        return;
      }
      const message = decoded.message;
      if (message.type === "welcome") {
        stopCreating();
        if (storesSeat) rememberSeat(message.playerId, message.reconnectToken);
      }
      dispatch({ type: "server_message", message });
      if (message.type === "error" && message.code === "bad_token") joinFreshAfterBadToken();
    };

    const unsubscribe = transport.subscribe(handle);
    return () => {
      unsubscribe();
      transport.close();
      transportRef.current = undefined;
    };
  }, [code, role, nickname, create, openTransport, notice]);

  const send = useCallback(
    (message: ClientMessage) => {
      const transport = transportRef.current;
      if (!transport) {
        notice("Not connected", "There is no connection to the room yet.");
        return;
      }
      const result = transport.send(message);
      if (!result.ok) notice("That didn't send", result.reason);
    },
    [notice],
  );

  const dismissNotice = useCallback((id: number) => dispatch({ type: "dismiss_notice", id }), []);

  return { session, send, dismissNotice };
};
