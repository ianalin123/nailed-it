"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { screenFor } from "@/lib/game/selectors";
import { useRoom, type OpenTransport } from "@/lib/room/useRoom";
import type { ConnectionState } from "@/lib/room/session";
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

type RoomScreenProps = {
  code: string;
  nickname: string;
  storageWarning?: string | undefined;
  openTransport?: OpenTransport;
};

export function RoomScreen({ code, nickname, storageWarning, openTransport }: RoomScreenProps) {
  const { session, send, dismissNotice } = useRoom(code, nickname, openTransport);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
      <TopBar code={code} connection={session.connection} />
      {storageWarning ? <p className="rounded-xl bg-field-deep p-3 text-field-soft">{storageWarning}</p> : null}
      <NoticeStack notices={session.notices} onDismiss={dismissNotice} />
      {session.room ? (
        <Stage room={session.room} viewerId={session.playerId} send={send} />
      ) : (
        <Waiting>{session.connection === "closed" ? "Not connected" : `Joining room ${code}`}</Waiting>
      )}
    </main>
  );
}
