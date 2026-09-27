import { accuracyLine, leaderboard } from "@/lib/game/selectors";
import { leaderboardColumns, pickTypeSize } from "@/lib/game/stageFit";
import { cx } from "../cx";
import { FINISHED, fontU, u } from "./geometry";
import { StageSlip } from "./StageSlip";
import type { StageProps } from "./types";

export function StageFinished({ room }: StageProps) {
  const board = leaderboard(room.players);
  const columns = leaderboardColumns(board.length);
  const accuracy = accuracyLine(room.readerAccuracy);
  const accuracySize = pickTypeSize(accuracy.length, FINISHED.accuracyBox, FINISHED.accuracySteps);
  return (
    <div className="grid h-full" style={{ gridTemplateColumns: "1.3fr 1fr", gap: u(4) }}>
      <section className="flex min-h-0 min-w-0 flex-col" style={{ gap: u(1.5) }}>
        <h1 className="wide font-black" style={fontU(FINISHED.headingU, 1)}>
          Final scores
        </h1>
        <ol className={cx("grid content-start", columns === 2 ? "grid-cols-2" : "grid-cols-1")} style={{ gap: u(0.5), columnGap: u(1.5) }}>
          {board.map(({ rank, player }, index) => {
            const winner = rank === 1 && columns === 1;
            const size = winner ? FINISHED.rowFontU.winner : columns === 2 ? FINISHED.rowFontU.double : FINISHED.rowFontU.single;
            return (
              <li
                key={player.id}
                className={cx("animate-feed flex min-w-0 items-center rounded-lg", rank === 1 ? "bg-slip text-ink" : "bg-field-deep")}
                style={{ ...fontU(size), gap: u(1.2), paddingInline: u(1.2), paddingBlock: u(0.45), animationDelay: `${(board.length - index) * 200}ms` }}
              >
                <span className="wide shrink-0 font-black tabular-nums" style={{ width: u(size * 1.4) }}>
                  {rank}
                </span>
                <span className="min-w-0 flex-1 truncate font-bold">{player.nickname}</span>
                <span className="wide shrink-0 font-black tabular-nums">{player.score}</span>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="flex min-h-0 flex-col justify-center">
        <StageSlip header="The reader, scored" text={accuracy} sizeU={accuracySize.sizeU} pad={{ xU: 2.4, topU: 1.8, bottomU: 3 }} />
      </section>
    </div>
  );
}
