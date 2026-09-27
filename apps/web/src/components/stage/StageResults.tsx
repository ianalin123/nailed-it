import type { CSSProperties } from "react";
import { GUESS_LABEL, type RevealRow } from "@/lib/game/selectors";
import { resultsLayout } from "@/lib/game/stageFit";
import { cx } from "../cx";
import { fontU, u } from "./geometry";

type StageResultsProps = {
  rows: readonly RevealRow[];
  fontSizeU: number;
  rowsPerColumn: number;
  maxColumns: 1 | 2;
  startMs: number;
  stepMs: number;
};

const byPoints = (a: RevealRow, b: RevealRow): number =>
  b.points - a.points || a.player.nickname.localeCompare(b.player.nickname);

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

export function StageResults({ rows, fontSizeU, rowsPerColumn, maxColumns, startMs, stepMs }: StageResultsProps) {
  const layout = resultsLayout(rows.length, rowsPerColumn, maxColumns);
  const shown = [...rows].sort(byPoints).slice(0, layout.shown);
  const rowStyle: CSSProperties = { ...fontU(fontSizeU), paddingBlock: u(0.3), gap: u(0.8) };
  return (
    <ol
      aria-label="This round"
      className={cx("grid content-start", layout.columns === 2 ? "grid-cols-2" : "grid-cols-1")}
      style={{ columnGap: u(2) }}
    >
      {shown.map((row, index) => (
        <li
          key={row.player.id}
          className="animate-feed flex items-baseline justify-between border-b border-field-soft/20"
          style={{ ...rowStyle, ...delay(startMs + index * stepMs) }}
        >
          <span className="min-w-0 truncate font-bold">{row.player.nickname}</span>
          <span className="flex shrink-0 items-baseline" style={{ gap: u(0.8) }}>
            <span className="text-field-soft">{row.guess ? GUESS_LABEL[row.guess].toLowerCase() : "no guess"}</span>
            <span className={cx("wide font-black tabular-nums", row.points > 0 ? "text-white" : "text-field-soft/70")}>
              +{row.points}
            </span>
          </span>
        </li>
      ))}
      {layout.hidden > 0 ? (
        <li className="animate-feed text-field-soft italic" style={{ ...rowStyle, ...delay(startMs + shown.length * stepMs) }}>
          +{layout.hidden} more players
        </li>
      ) : null}
    </ol>
  );
}
