"use client";

import { use } from "react";
import { FullScreenMessage } from "@/components/FullScreenMessage";
import { StageScreen } from "@/components/stage/StageScreen";
import { isValidRoomCode, normalizeRoomCode } from "@/lib/game/roomCode";

export default function StagePage({ params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = use(params);
  const code = normalizeRoomCode(decodeURIComponent(rawCode));
  if (!isValidRoomCode(code)) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6">
        <FullScreenMessage title="That isn't a room code">
          <p>Room codes are four letters. Open the big screen link from the host&apos;s phone.</p>
        </FullScreenMessage>
      </main>
    );
  }
  return <StageScreen key={code} code={code} />;
}
