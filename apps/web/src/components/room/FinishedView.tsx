import Link from "next/link";
import { accuracyLine, leaderboard } from "@/lib/game/selectors";
import { Slip } from "../Slip";
import { cx } from "../cx";
import { PlayerName } from "./PlayerName";
import type { ViewProps } from "./types";

export function FinishedView({ room, viewerId }: Omit<ViewProps, "send">) {
  const board = leaderboard(room.players);
  return (
    <div className="flex flex-col gap-8">
      <h1 className="wide font-black leading-[0.95] text-[clamp(2.6rem,12vw,5rem)]">Final scores</h1>
      <ol className="flex flex-col gap-2">
        {board.map(({ rank, player }) => (
          <li
            key={player.id}
            className={cx(
              "flex items-center gap-4 rounded-2xl px-4 py-3",
              rank === 1 ? "bg-slip text-ink" : "bg-field-deep",
            )}
          >
            <span className="wide w-8 shrink-0 text-2xl font-black tabular-nums">{rank}</span>
            <span className={cx("min-w-0 flex-1 truncate font-bold", rank === 1 ? "text-3xl" : "text-xl")}>
              <PlayerName player={player} viewerId={viewerId} />
            </span>
            <span className="wide shrink-0 text-2xl font-black tabular-nums">{player.score}</span>
          </li>
        ))}
      </ol>
      <Slip header="The reader, scored" size="hero">
        {accuracyLine(room.readerAccuracy)}
      </Slip>
      <Link
        href="/"
        className="wide block rounded-2xl bg-slip py-4 text-center text-xl font-extrabold text-ink shadow-[0_5px_0_0_var(--color-field-deep)]"
      >
        Start a new room
      </Link>
    </div>
  );
}
