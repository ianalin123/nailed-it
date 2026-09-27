"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { screenFor } from "@/lib/game/selectors";
import { useRoom, type OpenTransport } from "@/lib/room/useRoom";
import type { ConnectionState, JoinFailure } from "@/lib/room/session";
import { FullScreenMessage } from "../FullScreenMessage";
import { ConnectionBadge } from "../ConnectionBadge";
import { NoticeStack } from "../NoticeStack";
import { FinishedView } from "./FinishedView";
import { LobbyView } from "./LobbyView";
import { RevealView } from "./RevealView";
import { VotingView } from "./VotingView";
import type { ViewProps } from "./types";

function TopBar({ code, connection }: { code: string; connection: ConnectionState }) {
  return (
    <header className="flex items-center justify-between gap-3">
      <Link href="/" className="wide text-lg font-black">
        Nailed It
        <span className="ml-2 font-machine text-base font-normal text-field-soft">{code}</span>
      </Link>
      <ConnectionBadge state={connection} />
    </header>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return <p className="wide py-16 text-center text-2xl font-extrabold text-field-soft">{children}</p>;
}

function Stage(props: ViewProps) {
  switch (screenFor(props.room)) {
    case "lobby":
      return <LobbyView {...props} />;
    case "voting":
      return <VotingView {...props} />;
    case "reveal":
      return <RevealView {...props} />;
    case "dealing":
      return <Waiting>Dealing the next card</Waiting>;
    case "finished":
      return <FinishedView room={props.room} viewerId={props.viewerId} />;
  }
}

function JoinProblem({ code, failure }: { code: string; failure: JoinFailure }) {
  if (failure.code === "room_exists") return <Waiting>Room {code} is taken. Trying another code</Waiting>;
  return (
    <FullScreenMessage title={`There's no room ${code}`}>
      <p>Check the four letters on the host&apos;s screen and try again. {failure.message}</p>
    </FullScreenMessage>
  );
}

type RoomScreenProps = {
  code: string;
  nickname: string;
  create: boolean;
  storageWarning?: string | undefined;
  onCodeTaken?: () => void;
  openTransport?: OpenTransport;
};

export function RoomScreen({ code, nickname, create, storageWarning, onCodeTaken, openTransport }: RoomScreenProps) {
  const { session, send, dismissNotice } = useRoom(code, { role: "player", nickname, create }, openTransport);
  const taken = session.joinFailure?.code === "room_exists";
  useEffect(() => {
    if (taken) onCodeTaken?.();
  }, [taken, onCodeTaken]);
  useEffect(() => {
    if (create && session.room) window.history.replaceState(window.history.state, "", `/room/${code}`);
  }, [create, code, session.room]);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
      <TopBar code={code} connection={session.connection} />
      {storageWarning ? <p className="rounded-xl bg-field-deep p-3 text-field-soft">{storageWarning}</p> : null}
      <NoticeStack notices={session.notices} onDismiss={dismissNotice} />
      {session.room ? (
        <Stage room={session.room} viewerId={session.playerId} send={send} />
      ) : session.joinFailure ? (
        <JoinProblem code={code} failure={session.joinFailure} />
      ) : (
        <Waiting>{session.connection === "closed" ? "Not connected" : `Joining room ${code}`}</Waiting>
      )}
    </main>
  );
}
