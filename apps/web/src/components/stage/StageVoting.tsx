import { stageReadSize } from "@/lib/game/chain";
import { guessers, hasVoted, hotSeatPlayer, possessive, roundLabel, voteProgress } from "@/lib/game/selectors";
import { Slip, type SlipSize } from "../Slip";
import { cx } from "../cx";
import type { StageProps } from "./types";

const VOTING_SIZE = { xl: "stage-xl", lg: "stage-lg", md: "stage-md" } as const satisfies Record<string, SlipSize>;

export function StageVoting({ room }: StageProps) {
  const round = room.round;
  if (!round) return null;
  const hotSeat = hotSeatPlayer(room);
  const progress = voteProgress(room);
  return (
    <div className="grid flex-1 grid-cols-[1fr_22vw] gap-[3vw]">
      <div className="flex min-w-0 flex-col gap-[2vw]">
        <h1 className="wide text-[4vw] font-black leading-none wrap-anywhere">
          {possessive(hotSeat?.nickname ?? "Someone")} in the hot seat
        </h1>
        <Slip feedKey={round.read.id} header={roundLabel(round)} size={VOTING_SIZE[stageReadSize(round.read.text)]}>
          {round.read.text}
        </Slip>
      </div>
      <aside className="flex flex-col gap-[1.2vw] pt-[1vw]" aria-label="Who has guessed">
        <p className="wide text-[5vw] font-black leading-none tabular-nums">
          {progress.voted}
          <span className="text-[2.4vw] text-field-soft"> of {progress.eligible}</span>
        </p>
        <p className="text-[1.6vw] text-field-soft">have guessed</p>
        <ul className="flex flex-col gap-[0.6vw]">
          {guessers(room).map((player) => {
            const voted = hasVoted(room, player.id);
            return (
              <li
                key={`${player.id}-${voted ? "in" : "out"}`}
                className={cx(
                  "flex items-center justify-between gap-[0.8vw] rounded-[0.6vw] px-[1vw] py-[0.5vw] text-[1.7vw] font-bold",
                  voted ? "animate-stamp bg-slip text-ink [--stamp-tilt:0deg]" : "border-[0.15vw] border-dashed border-field-soft/50 text-field-soft",
                )}
              >
                <span className="min-w-0 truncate">{player.nickname}</span>
                <span className="shrink-0 text-[1.2vw] font-semibold">{voted ? "guessed" : "thinking"}</span>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
