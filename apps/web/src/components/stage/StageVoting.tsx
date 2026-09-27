import { STAGE_FLOOR_U, pickTypeSize, voterRowSize } from "@/lib/game/stageFit";
import { guessers, hasVoted, hotSeatPlayer, possessive, roundLabel, voteProgress } from "@/lib/game/selectors";
import { cx } from "../cx";
import { VOTING, fontU, u } from "./geometry";
import { StageSlip } from "./StageSlip";
import type { StageProps } from "./types";

export function StageVoting({ room }: StageProps) {
  const round = room.round;
  if (!round) return null;
  const hotSeat = hotSeatPlayer(room);
  const progress = voteProgress(room);
  const voters = guessers(room);
  const readSize = pickTypeSize(round.read.text.length, VOTING.readBox, VOTING.readSteps);
  const rowSize = voterRowSize(voters.length);
  return (
    <div className="grid h-full" style={{ gridTemplateColumns: `1fr ${u(VOTING.asideU)}`, gap: u(VOTING.gapU) }}>
      <div className="flex min-w-0 flex-col" style={{ gap: u(1.6) }}>
        <h1 className="wide truncate font-black" style={fontU(VOTING.headingU, 1)}>
          {possessive(hotSeat?.nickname ?? "Someone")} in the hot seat
        </h1>
        <StageSlip
          feedKey={round.read.id}
          header={roundLabel(round)}
          text={round.read.text}
          sizeU={readSize.sizeU}
          pad={{ xU: 2.4, topU: 1.8, bottomU: 3 }}
        />
      </div>
      <aside className="flex min-h-0 flex-col" aria-label="Who has guessed" style={{ gap: u(0.8) }}>
        <p className="wide font-black tabular-nums" style={fontU(4.4, 1)}>
          {progress.voted}
          <span className="text-field-soft" style={fontU(2.2, 1)}>
            {" "}
            of {progress.eligible}
          </span>
        </p>
        <p className="text-field-soft" style={fontU(1.5)}>
          have guessed
        </p>
        <ul className="flex flex-col" style={{ gap: u(0.5) }}>
          {voters.map((player) => {
            const voted = hasVoted(room, player.id);
            return (
              <li
                key={`${player.id}-${voted ? "in" : "out"}`}
                className={cx(
                  "flex items-center justify-between rounded-md font-bold",
                  voted ? "animate-stamp bg-slip text-ink [--stamp-tilt:0deg]" : "border-2 border-dashed border-field-soft/50 text-field-soft",
                )}
                style={{ ...fontU(rowSize, 1.3), gap: u(0.8), paddingInline: u(0.9), paddingBlock: u(0.2) }}
              >
                <span className="min-w-0 truncate">{player.nickname}</span>
                <span className="shrink-0 font-semibold" style={fontU(Math.max(STAGE_FLOOR_U, rowSize * 0.8), 1.3)}>
                  {voted ? "guessed" : "thinking"}
                </span>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
