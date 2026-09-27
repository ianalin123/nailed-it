"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ROOM_CODE_LENGTH } from "@nailed-it/protocol";
import { checkNickname, generateRoomCode, isValidRoomCode, normalizeRoomCode } from "@/lib/game/roomCode";
import { loadNickname, saveNickname } from "@/lib/room/identity";
import { ActionButton } from "../ActionButton";
import { NicknameField } from "../NicknameField";

type Intent = "create" | "join";
type Errors = { nickname?: string; code?: string; storage?: string };

export function StartForm() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    const stored = loadNickname();
    if (stored.ok && stored.value) setNickname(stored.value);
    if (!stored.ok) setErrors({ storage: stored.reason });
  }, []);

  const go = (intent: Intent) => (event: FormEvent) => {
    event.preventDefault();
    const name = checkNickname(nickname);
    const roomCode = intent === "create" ? generateRoomCode() : normalizeRoomCode(code);
    const next: Errors = {};
    if (!name.ok) next.nickname = name.reason;
    if (!isValidRoomCode(roomCode)) next.code = `Enter the ${ROOM_CODE_LENGTH}-letter code from the host's screen.`;
    if (next.nickname || next.code) {
      setErrors(next);
      return;
    }
    if (!name.ok) return;
    const saved = saveNickname(name.nickname);
    if (!saved.ok) {
      setErrors({ storage: saved.reason });
    }
    router.push(`/room/${roomCode}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={go("create")} className="flex flex-col gap-4">
        <NicknameField value={nickname} onChange={setNickname} error={errors.nickname} />
        <ActionButton tone="nailed" big type="submit">
          Start a room
        </ActionButton>
      </form>
      <form onSubmit={go("join")} className="flex flex-col gap-2" noValidate>
        <label htmlFor="room-code" className="text-lg font-semibold">
          Or join a friend&apos;s room
        </label>
        <div className="flex gap-3">
          <input
            id="room-code"
            value={code}
            onChange={(event) => setCode(normalizeRoomCode(event.target.value))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="KQRT"
            aria-invalid={errors.code ? true : undefined}
            aria-describedby={errors.code ? "code-error" : undefined}
            className="wide min-h-14 w-0 flex-1 rounded-xl bg-field-deep px-4 text-center text-3xl font-black tracking-[0.3em] text-white placeholder:text-field-soft/40"
          />
          <ActionButton tone="primary" type="submit" className="w-auto! shrink-0 px-7">
            Join
          </ActionButton>
        </div>
        {errors.code ? (
          <span id="code-error" role="alert" className="text-alarm">
            {errors.code}
          </span>
        ) : null}
      </form>
      {errors.storage ? (
        <p role="alert" className="rounded-xl bg-field-deep p-3 text-field-soft">
          {errors.storage}
        </p>
      ) : null}
    </div>
  );
}
