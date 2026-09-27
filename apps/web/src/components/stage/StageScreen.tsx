"use client";

import type { ReactNode } from "react";
import { screenFor } from "@/lib/game/selectors";
import type { ConnectionState, JoinFailure } from "@/lib/room/session";
import { useRoom, type OpenTransport } from "@/lib/room/useRoom";
import { ConnectionBadge } from "../ConnectionBadge";
import { NoticeStack } from "../NoticeStack";
import { CONTENT, FRAME, fontU, u } from "./geometry";
import { StageFinished } from "./StageFinished";
import { StageLobby } from "./StageLobby";
import { StageReveal } from "./StageReveal";
import { StageVoting } from "./StageVoting";
import type { StageProps } from "./types";

const STAGE_PLAN = { role: "stage" } as const;

function StageBar({ code, connection }: { code: string; connection: ConnectionState }) {
  return (
    <header className="flex items-center justify-between" style={{ ...fontU(1.4, 1), height: u(FRAME.barU), gap: u(2) }}>
      <p className="wide font-black">
        Nailed It{" "}
        <span className="font-machine font-normal text-field-soft" style={{ marginLeft: u(0.6) }}>
          {code}
        </span>
      </p>
      {connection === "open" ? null : <ConnectionBadge state={connection} />}
    </header>
  );
}

function Hold({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="wide text-center font-extrabold text-field-soft" style={fontU(3.4)}>
        {children}
      </p>
    </div>
  );
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
    <div role="alert" className="flex h-full flex-col items-center justify-center text-center" style={{ gap: u(1.5) }}>
      <h1 className="wide font-black" style={fontU(4, 1)}>
        There&apos;s no room {code}
      </h1>
      <p className="text-field-soft" style={{ ...fontU(1.8), maxWidth: u(60) }}>
        Create the room on a phone first, then open this screen again. {failure.message}
      </p>
    </div>
  );
}

type StageScreenProps = { code: string; openTransport?: OpenTransport };

export function StageScreen({ code, openTransport }: StageScreenProps) {
  const { session, dismissNotice } = useRoom(code, STAGE_PLAN, openTransport);
  return (
    <main className="stage-root flex w-full items-center justify-center">
      <div
        className="relative flex flex-col"
        style={{
          width: u(FRAME.widthU),
          height: u(FRAME.heightU),
          paddingInline: u(FRAME.padXU),
          paddingBlock: u(FRAME.padYU),
          gap: u(FRAME.gapU),
        }}
      >
        <StageBar code={code} connection={session.connection} />
        <div data-fit="stage-content" className="min-h-0 overflow-hidden" style={{ width: u(CONTENT.widthU), height: u(CONTENT.heightU) }}>
          {session.room ? (
            <Scene room={session.room} />
          ) : session.joinFailure ? (
            <StageProblem code={code} failure={session.joinFailure} />
          ) : (
            <Hold>{session.connection === "closed" ? "Not connected" : `Opening room ${code}`}</Hold>
          )}
        </div>
        {session.notices.length > 0 ? (
          <div className="absolute z-10" style={{ ...fontU(1.1), left: u(FRAME.padXU), bottom: u(FRAME.padYU), width: u(40) }}>
            <NoticeStack notices={session.notices} onDismiss={dismissNotice} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
