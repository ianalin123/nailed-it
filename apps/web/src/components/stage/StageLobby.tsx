"use client";

import { QRCodeSVG } from "qrcode.react";
import { deckCount } from "@/lib/game/selectors";
import { roomUrls } from "@/lib/game/urls";
import { cx } from "../cx";
import { useOrigin } from "../useOrigin";
import { fontU, u } from "./geometry";
import type { StageProps } from "./types";

const QR_U = 17;

function JoinCard({ code }: { code: string }) {
  const origin = useOrigin();
  if (!origin) return <div aria-hidden className="rounded-lg bg-field-deep" style={{ width: u(QR_U + 2.2), height: u(QR_U + 2.2) }} />;
  const urls = roomUrls(origin, code);
  return (
    <figure className="flex flex-col items-center" style={{ gap: u(1) }}>
      <div className="rounded-lg bg-slip" style={{ padding: u(1.1) }}>
        <QRCodeSVG
          value={urls.join}
          size={512}
          level="M"
          marginSize={0}
          fgColor="#121a5c"
          bgColor="#f2f4f3"
          title={`Scan to join room ${code}`}
          style={{ width: u(QR_U), height: u(QR_U), display: "block" }}
        />
      </div>
      <figcaption className="text-center font-machine break-all text-field-soft" style={{ ...fontU(1.1), maxWidth: u(QR_U + 2.2) }}>
        {urls.display}/room/{code}
      </figcaption>
    </figure>
  );
}

export function StageLobby({ room }: StageProps) {
  const decks = deckCount(room);
  return (
    <div className="grid h-full grid-cols-[auto_1fr] items-start" style={{ gap: u(4) }}>
      <JoinCard code={room.code} />
      <div className="flex min-w-0 flex-col" style={{ gap: u(2.5) }}>
        <div>
          <p className="text-field-soft" style={fontU(1.8)}>
            Scan the code with your phone, or enter
          </p>
          <p className="wide font-black whitespace-nowrap" style={{ ...fontU(10, 0.9), letterSpacing: "0.06em" }}>
            {room.code}
          </p>
        </div>
        <section>
          <h2 className="flex items-baseline justify-between border-b-2 border-field-soft/30" style={{ ...fontU(1.6), paddingBottom: u(0.6) }}>
            <span className="wide font-extrabold">In the room</span>
            <span className="text-field-soft">
              {room.players.length} here, {decks} {decks === 1 ? "deck" : "decks"}
            </span>
          </h2>
          {room.players.length === 0 ? (
            <p className="text-field-soft" style={{ ...fontU(1.8), paddingTop: u(1) }}>
              Waiting for the first player.
            </p>
          ) : (
            <ul className="grid grid-cols-3" style={{ columnGap: u(2), paddingTop: u(1) }}>
              {room.players.map((player) => (
                <li
                  key={player.id}
                  className={cx("animate-feed flex min-w-0 items-center", !player.connected && "opacity-50")}
                  style={{ gap: u(0.8), paddingBlock: u(0.4) }}
                >
                  <span className="min-w-0 truncate font-bold" style={fontU(2.2)}>
                    {player.nickname}
                  </span>
                  {player.hasDeck ? (
                    <span
                      className="wide shrink-0 -rotate-6 rounded border-2 border-nailed font-black text-nailed uppercase"
                      style={{ ...fontU(1, 1.3), paddingInline: u(0.5) }}
                    >
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
