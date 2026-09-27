import type { Player } from "@nailed-it/protocol";

export function PlayerName({ player, viewerId }: { player: Player; viewerId: string | undefined }) {
  return (
    <>
      {player.nickname}
      {player.id === viewerId ? <span className="font-normal opacity-75"> (you)</span> : null}
    </>
  );
}
