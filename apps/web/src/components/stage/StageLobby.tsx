"use client";

import { QRCodeSVG } from "qrcode.react";
import { deckCount } from "@/lib/game/selectors";
import { roomUrls } from "@/lib/game/urls";
import { cx } from "../cx";
import { useOrigin } from "../useOrigin";
import type { StageProps } from "./types";

function JoinCard({ code }: { code: string }) {
  const origin = useOrigin();
  if (!origin) return <div className="aspect-square w-[19vw] rounded-[1vw] bg-field-deep" aria-hidden />;
  const urls = roomUrls(origin, code);
  return (
    <figure className="flex flex-col items-center gap-[1vw]">
      <div className="rounded-[1vw] bg-slip p-[1.1vw]">
        <QRCodeSVG
          value={urls.join}
          size={512}
          level="M"
          marginSize={0}
          fgColor="#121a5c"
          bgColor="#f2f4f3"
          title={`Scan to join room ${code}`}
          style={{ width: "17vw", height: "17vw" }}
        />
      </div>
      <figcaption className="max-w-[21vw] text-center font-machine text-[1.25vw] break-all text-field-soft">
        {urls.display}/room/{code}
      </figcaption>
    </figure>
  );
}

export function StageLobby({ room }: StageProps) {
  const decks = deckCount(room);
  return (
    <div className="grid flex-1 grid-cols-[auto_1fr] items-start gap-[4vw]">
      <JoinCard code={room.code} />
      <div className="flex min-w-0 flex-col gap-[2.5vw]">
        <div>
          <p className="text-[2vw] text-field-soft">Scan the code with your phone, or enter</p>
          <p className="wide font-black whitespace-nowrap tracking-[0.06em] text-[10vw] leading-[0.9]">{room.code}</p>
        </div>
        <section>
          <h2 className="flex items-baseline justify-between border-b-[0.2vw] border-field-soft/30 pb-[0.6vw] text-[1.7vw]">
            <span className="wide font-extrabold">In the room</span>
            <span className="text-field-soft">
              {room.players.length} here, {decks} {decks === 1 ? "deck" : "decks"}
            </span>
          </h2>
          {room.players.length === 0 ? (
            <p className="pt-[1vw] text-[2vw] text-field-soft">Waiting for the first player.</p>
          ) : (
            <ul className="grid grid-cols-3 gap-x-[2vw] gap-y-[0.4vw] pt-[1vw]">
              {room.players.map((player) => (
                <li
                  key={player.id}
                  className={cx("animate-feed flex min-w-0 items-center gap-[0.8vw] py-[0.4vw]", !player.connected && "opacity-50")}
                >
                  <span className="min-w-0 truncate text-[2.4vw] font-bold">{player.nickname}</span>
                  {player.hasDeck ? (
                    <span className="wide shrink-0 -rotate-6 rounded-[0.4vw] border-[0.25vw] border-nailed px-[0.5vw] text-[1vw] font-black text-nailed uppercase">
                      Deck in
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
