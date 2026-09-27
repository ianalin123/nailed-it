import type { Player } from "@nailed-it/protocol";
import { possessive } from "@/lib/game/selectors";

export function HotSeatHeading({ hotSeat, viewerId }: { hotSeat: Player | undefined; viewerId: string | undefined }) {
  const isViewer = hotSeat?.id === viewerId;
  return (
    <h1 className="wide font-black leading-[0.95] text-[clamp(2.2rem,10vw,4.5rem)] text-balance">
      {isViewer ? "You're in the hot seat" : `${possessive(hotSeat?.nickname ?? "Someone")} in the hot seat`}
    </h1>
  );
}
