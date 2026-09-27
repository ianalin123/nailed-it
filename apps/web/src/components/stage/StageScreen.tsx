"use client";

import type { ReactNode } from "react";
import { screenFor } from "@/lib/game/selectors";
import type { ConnectionState, JoinFailure } from "@/lib/room/session";
import { useRoom, type OpenTransport } from "@/lib/room/useRoom";
import { ConnectionBadge } from "../ConnectionBadge";
import { NoticeStack } from "../NoticeStack";
import { StageFinished } from "./StageFinished";
import { StageLobby } from "./StageLobby";
import { StageReveal } from "./StageReveal";
import { StageVoting } from "./StageVoting";
import type { StageProps } from "./types";

const STAGE_PLAN = { role: "stage" } as const;

function StageBar({ code, connection }: { code: string; connection: ConnectionState }) {
  return (
    <header className="flex items-center justify-between gap-[2vw] text-[1.4vw]">
      <p className="wide font-black">
        Nailed It <span className="ml-[0.6vw] font-machine font-normal text-field-soft">{code}</span>
      </p>
      {connection === "open" ? null : <ConnectionBadge state={connection} />}
    </header>
  );
}

function Hold({ children }: { children: ReactNode }) {
  return <p className="wide m-auto text-center text-[3.4vw] font-extrabold text-field-soft">{children}</p>;
}

function Scene({ room }: StageProps) {
  switch (screenFor(room)) {
    case "lobby":
      return <StageLobby room={room} />;
    case "voting":
      return <StageVoting room={room} />;
    case "reveal":
      return <StageReveal room={room} />;
    case "dealing":
      return <Hold>Dealing the next card</Hold>;
    case "finished":
      return <StageFinished room={room} />;
  }
}

function StageProblem({ code, failure }: { code: string; failure: JoinFailure }) {
  return (
    <div role="alert" className="m-auto flex max-w-[60vw] flex-col gap-[1.5vw] text-center">
      <h1 className="wide text-[4vw] font-black leading-none">There&apos;s no room {code}</h1>
      <p className="text-[1.8vw] text-field-soft">
        Create the room on a phone first, then open this screen again. {failure.message}
      </p>
    </div>
  );
}

type StageScreenProps = { code: string; openTransport?: OpenTransport };

export function StageScreen({ code, openTransport }: StageScreenProps) {
  const { session, dismissNotice } = useRoom(code, STAGE_PLAN, openTransport);
  return (
    <main className="flex min-h-dvh w-full flex-col gap-[2vw] px-[3.5vw] py-[2.5vw]">
      <StageBar code={code} connection={session.connection} />
      {session.notices.length > 0 ? (
        <div className="max-w-[50vw] text-[1.2vw]">
          <NoticeStack notices={session.notices} onDismiss={dismissNotice} />
        </div>
      ) : null}
      {session.room ? (
        <Scene room={session.room} />
      ) : session.joinFailure ? (
        <StageProblem code={code} failure={session.joinFailure} />
      ) : (
        <Hold>{session.connection === "closed" ? "Not connected" : `Opening room ${code}`}</Hold>
      )}
    </main>
  );
}
