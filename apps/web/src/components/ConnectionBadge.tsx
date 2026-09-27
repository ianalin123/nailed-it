import { CONNECTION_LABEL, type ConnectionState } from "@/lib/room/session";
import { cx } from "./cx";

const DOT: Record<ConnectionState, string> = {
  connecting: "bg-partly animate-pulse",
  open: "bg-[#5dffb0]",
  reconnecting: "bg-partly animate-pulse",
  closed: "bg-nailed",
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold",
        state === "open" ? "bg-field-deep/60 text-field-soft" : "bg-slip text-ink",
      )}
    >
      <span aria-hidden className={cx("size-2.5 rounded-full", DOT[state])} />
      {CONNECTION_LABEL[state]}
    </span>
  );
}
