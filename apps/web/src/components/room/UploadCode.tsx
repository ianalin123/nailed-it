"use client";

import { useState } from "react";
import { loadSeat } from "@/lib/room/identity";
import { CopyButton } from "../CopyButton";

type Revealed = { kind: "hidden" } | { kind: "shown"; playerId: string; token: string } | { kind: "missing"; reason: string };

const NO_TOKEN =
  "This device doesn't have your upload code. Reload this page to rejoin, and it will be saved again.";

const revealFor = (code: string, playerId: string): Revealed => {
  const seat = loadSeat(code);
  if (!seat.ok) return { kind: "missing", reason: seat.reason };
  if (!seat.value || seat.value.playerId !== playerId || seat.value.token === undefined) {
    return { kind: "missing", reason: NO_TOKEN };
  }
  return { kind: "shown", playerId, token: seat.value.token };
};

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-20 shrink-0 text-sm text-field-soft">{label}</span>
      <code className="min-w-0 flex-1 font-machine text-base break-all text-slip">{value}</code>
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} className="rounded-md bg-slip px-3 py-1 text-sm font-bold text-ink" />
    </div>
  );
}

export function UploadCode({ code, playerId }: { code: string; playerId: string }) {
  const [revealed, setRevealed] = useState<Revealed>({ kind: "hidden" });
  if (revealed.kind === "hidden") {
    return (
      <button
        type="button"
        onClick={() => setRevealed(revealFor(code, playerId))}
        className="self-start text-base font-semibold underline underline-offset-4"
      >
        Show my upload code
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-ink p-4" aria-label="Your upload code">
      <p className="text-sm font-semibold text-partly">
        This is a secret that lets anyone play as you. Don&apos;t show it on a shared screen.
      </p>
      {revealed.kind === "shown" ? (
        <>
          <SecretRow label="Player id" value={revealed.playerId} />
          <SecretRow label="Token" value={revealed.token} />
        </>
      ) : (
        <p role="alert" className="text-alarm">
          {revealed.reason}
        </p>
      )}
      <button
        type="button"
        onClick={() => setRevealed({ kind: "hidden" })}
        className="self-start text-sm font-semibold text-field-soft underline underline-offset-4"
      >
        Hide upload code
      </button>
    </div>
  );
}
