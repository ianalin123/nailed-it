"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { checkNickname, isValidRoomCode, normalizeRoomCode } from "@/lib/game/roomCode";
import { loadNickname, saveNickname } from "@/lib/room/identity";
import { ActionButton } from "../ActionButton";
import { NicknameField } from "../NicknameField";
import { RoomScreen } from "./RoomScreen";

type Entry =
  | { stage: "loading" }
  | { stage: "ask"; storageWarning: string | undefined }
  | { stage: "ready"; nickname: string; storageWarning: string | undefined };

function NicknameGate({ code, warning, onReady }: { code: string; warning: string | undefined; onReady: (nickname: string, storageWarning: string | undefined) => void }) {
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
      {warning ? <p role="alert" className="rounded-xl bg-slip p-3 text-ink">{warning}</p> : null}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <NicknameField value={value} onChange={setValue} error={error} />
        <ActionButton tone="nailed" big type="submit">
          Join the room
        </ActionButton>
      </form>
    </main>
  );
}

export function RoomEntry({ rawCode }: { rawCode: string }) {
  const code = normalizeRoomCode(rawCode);
  const [entry, setEntry] = useState<Entry>({ stage: "loading" });

  useEffect(() => {
    const stored = loadNickname();
    if (stored.ok && stored.value) {
      setEntry({ stage: "ready", nickname: stored.value, storageWarning: undefined });
      return;
    }
    setEntry({ stage: "ask", storageWarning: stored.ok ? undefined : stored.reason });
  }, []);

  if (!isValidRoomCode(code) || code !== rawCode.toUpperCase()) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
        <h1 className="wide text-4xl font-black">That isn&apos;t a room code</h1>
        <p className="text-field-soft">Room codes are four letters, like KQRT. Check the code on the host&apos;s screen.</p>
        <Link href="/" className="font-bold underline underline-offset-4">Back to the start</Link>
      </main>
    );
  }
  switch (entry.stage) {
    case "loading":
      return null;
    case "ask":
      return (
        <NicknameGate
          code={code}
          warning={entry.storageWarning}
          onReady={(nickname, storageWarning) => setEntry({ stage: "ready", nickname, storageWarning })}
        />
      );
    case "ready":
      return <RoomScreen code={code} nickname={entry.nickname} storageWarning={entry.storageWarning} />;
  }
}
