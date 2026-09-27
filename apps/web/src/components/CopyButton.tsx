"use client";

import { useState } from "react";

type CopyState = { kind: "idle" } | { kind: "copied" } | { kind: "failed"; reason: string };

type CopyButtonProps = { value: string; label: string; className?: string };

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [copy, setCopy] = useState<CopyState>({ kind: "idle" });
  const copyValue = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopy({ kind: "copied" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setCopy({ kind: "failed", reason });
    }
  };
  return (
    <>
      <button type="button" onClick={copyValue} aria-label={label} className={className}>
        {copy.kind === "copied" ? "Copied" : "Copy"}
      </button>
      {copy.kind === "failed" ? (
        <span role="alert" className="basis-full text-sm text-alarm">
          Couldn&apos;t copy ({copy.reason}). Select it and copy by hand.
        </span>
      ) : null}
    </>
  );
}
