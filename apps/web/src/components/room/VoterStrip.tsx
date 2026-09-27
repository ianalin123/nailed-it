import type { Player } from "@nailed-it/protocol";
import { cx } from "../cx";

type VoterStripProps = { voters: readonly Player[]; votedIds: readonly string[]; viewerId: string | undefined };

export function VoterStrip({ voters, votedIds, viewerId }: VoterStripProps) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Who has guessed">
      {voters.map((player) => {
        const voted = votedIds.includes(player.id);
        return (
          <li
            key={player.id}
            className={cx(
              "rounded-full px-3 py-1.5 text-sm font-bold",
              voted ? "bg-slip text-ink" : "border-2 border-dashed border-field-soft/50 text-field-soft",
            )}
          >
            {player.id === viewerId ? "You" : player.nickname}
            <span className="font-normal">{voted ? " guessed" : " thinking"}</span>
          </li>
        );
      })}
    </ul>
  );
}
