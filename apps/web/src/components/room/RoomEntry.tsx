"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { checkNickname, isValidRoomCode, normalizeRoomCode } from "@/lib/game/roomCode";
import { loadNickname, saveNickname } from "@/lib/room/identity";
import { planCreateRetry } from "@/lib/room/joinPlan";
import { ActionButton } from "../ActionButton";
import { FullScreenMessage } from "../FullScreenMessage";
import { NicknameField } from "../NicknameField";
import { RoomScreen } from "./RoomScreen";

type Entry =
  | { stage: "loading" }
  | { stage: "ask"; storageWarning: string | undefined }
  | { stage: "ready"; nickname: string; storageWarning: string | undefined }
  | { stage: "gave_up"; reason: string };

type NicknameGateProps = {
  code: string;
  warning: string | undefined;
  onReady: (nickname: string, storageWarning: string | undefined) => void;
};

function NicknameGate({ code, warning, onReady }: NicknameGateProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const check = checkNickname(value);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    const saved = saveNickname(check.nickname);
    onReady(check.nickname, saved.ok ? undefined : saved.reason);
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-10">
      <h1 className="wide text-5xl font-black leading-none">Joining {code}</h1>
      {warning ? (
        <p role="alert" className="rounded-xl bg-slip p-3 text-ink">
          {warning}
        </p>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <NicknameField value={value} onChange={setValue} error={error} />
        <ActionButton tone="nailed" big type="submit">
          Join the room
        </ActionButton>
      </form>
    </main>
  );
}

const Shell = ({ children }: { children: ReactNode }) => (
  <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4">{children}</main>
);

type RoomEntryProps = { rawCode: string; createAttempt: number | undefined };

export function RoomEntry({ rawCode, createAttempt }: RoomEntryProps) {
  const router = useRouter();
  const code = normalizeRoomCode(rawCode);
  const [entry, setEntry] = useState<Entry>({ stage: "loading" });
  const [create] = useState(createAttempt !== undefined);

  useEffect(() => {
    const stored = loadNickname();
    if (stored.ok && stored.value) {
      setEntry({ stage: "ready", nickname: stored.value, storageWarning: undefined });
      return;
    }
    setEntry({ stage: "ask", storageWarning: stored.ok ? undefined : stored.reason });
  }, []);

  const onCodeTaken = useCallback(() => {
    const retry = planCreateRetry(code, createAttempt ?? 1);
    if (retry.kind === "give_up") {
      setEntry({ stage: "gave_up", reason: retry.reason });
      return;
    }
    router.replace(`/room/${retry.code}?create=${retry.attempt}`);
  }, [code, createAttempt, router]);

  if (!isValidRoomCode(code) || code !== rawCode.toUpperCase()) {
    return (
      <Shell>
        <FullScreenMessage title="That isn't a room code">
          <p>Room codes are four letters, like KQRT. Check the code on the host&apos;s screen.</p>
        </FullScreenMessage>
      </Shell>
    );
  }
  switch (entry.stage) {
    case "loading":
      return null;
    case "gave_up":
      return (
        <Shell>
          <FullScreenMessage title="Couldn't start a room">
            <p>{entry.reason}</p>
          </FullScreenMessage>
        </Shell>
      );
    case "ask":
      return (
        <NicknameGate
          code={code}
          warning={entry.storageWarning}
          onReady={(nickname, storageWarning) => setEntry({ stage: "ready", nickname, storageWarning })}
        />
      );
    case "ready":
      return (
        <RoomScreen
          code={code}
          nickname={entry.nickname}
          create={create}
          storageWarning={entry.storageWarning}
          onCodeTaken={onCodeTaken}
        />
      );
  }
}
