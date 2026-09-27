"use client";

import { useState } from "react";
import type { Player } from "@nailed-it/protocol";
import { buildDemoDeck } from "@/lib/game/demoDeck";
import {
  CARDS_PER_PLAYER_DEFAULT,
  CARDS_PER_PLAYER_MIN,
  cardsPerPlayerLimit,
  clampCardsPerPlayer,
  deckCount,
  findPlayer,
  isHost,
  startStatus,
} from "@/lib/game/selectors";
import { roomUrls } from "@/lib/game/urls";
import { ActionButton } from "../ActionButton";
import { CopyButton } from "../CopyButton";
import { cx } from "../cx";
import { useOrigin } from "../useOrigin";
import { PlayerName } from "./PlayerName";
import { UploadCode } from "./UploadCode";
import type { ViewProps } from "./types";

export const pluginCommand = (code: string): string => `/nailed-it:read ${code}`;

function RosterRow({ player, viewerId }: { player: Player; viewerId: string | undefined }) {
  return (
    <li className={cx("flex items-center justify-between gap-3 py-3", !player.connected && "opacity-55")}>
      <span className="min-w-0 truncate text-xl font-bold">
        <PlayerName player={player} viewerId={viewerId} />
        {player.isHost ? <span className="ml-2 text-sm font-semibold text-field-soft">host</span> : null}
        {!player.connected ? <span className="ml-2 text-sm font-semibold text-field-soft">offline</span> : null}
      </span>
      {player.hasDeck ? (
        <span className="wide shrink-0 -rotate-3 rounded-md border-[3px] border-nailed px-2 py-0.5 text-sm font-black text-nailed uppercase">
          Deck in
        </span>
      ) : (
        <span className="shrink-0 text-sm text-field-soft">No deck</span>
      )}
    </li>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex flex-wrap items-stretch overflow-hidden rounded-xl bg-ink">
      <code className="min-w-0 flex-1 overflow-x-auto px-4 py-3 font-machine text-lg whitespace-nowrap text-slip">
        {command}
      </code>
      <CopyButton value={command} label="Copy command" className="shrink-0 bg-slip px-4 font-bold text-ink" />
    </div>
  );
}

type DeckPanelProps = { code: string; viewer: Player; onDemo: () => void };

function DeckPanel({ code, viewer, onDemo }: DeckPanelProps) {
  if (viewer.hasDeck) {
    return (
      <section className="rounded-2xl bg-field-deep p-5">
        <h2 className="wide text-2xl font-extrabold">Your deck is in</h2>
        <p className="mt-1 text-field-soft">
          {viewer.deckSize === undefined ? "The reader" : `${viewer.deckSize} reads. The reader`} has its guesses about
          you. Nobody sees them until the game starts.
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-field-deep p-5">
      <div>
        <h2 className="wide text-2xl font-extrabold">Get read</h2>
        <p className="mt-1 max-w-prose text-field-soft">
          Run this in Claude Code on your own computer. The reader looks at your files there, you approve what it
          uses, and only its reads come to this room. It will ask for your upload code.
        </p>
      </div>
      <CommandLine command={pluginCommand(code)} />
      <UploadCode code={code} playerId={viewer.id} />
      <div className="flex flex-col gap-2 border-t-2 border-field-soft/20 pt-4 sm:flex-row sm:items-center">
        <ActionButton tone="quiet" onClick={onDemo} className="border-2 border-field-soft/40 sm:w-auto">
          Use demo deck
        </ActionButton>
        <p className="text-sm text-field-soft">Reads about a made-up person, so you can play without the plugin.</p>
      </div>
    </section>
  );
}

function StageLink({ code }: { code: string }) {
  const origin = useOrigin();
  if (!origin) return null;
  const { stage } = roomUrls(origin, code);
  return (
    <section className="flex flex-col gap-2 rounded-2xl border-2 border-dashed border-field-soft/40 p-4">
      <h2 className="text-lg font-bold">Put the game on a big screen</h2>
      <p className="text-sm text-field-soft">Open this on a laptop plugged into the TV. You keep running the game from here.</p>
      <div className="flex flex-wrap items-center gap-2">
        <a href={stage} target="_blank" rel="noreferrer" className="min-w-0 flex-1 font-machine break-all underline underline-offset-4">
          {stage}
        </a>
        <CopyButton value={stage} label="Copy big screen link" className="rounded-md bg-slip px-3 py-1 text-sm font-bold text-ink" />
      </div>
    </section>
  );
}

type HostControlsProps = { limit: number; canStart: boolean; reason: string | undefined; onStart: (cards: number) => void };

function HostControls({ limit, canStart, reason, onStart }: HostControlsProps) {
  const [wanted, setWanted] = useState(CARDS_PER_PLAYER_DEFAULT);
  const cards = clampCardsPerPlayer(wanted, limit);
  const step = (delta: number) => setWanted(clampCardsPerPlayer(cards + delta, limit));
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <span id="cards-label" className="text-lg font-semibold">
          Cards per player
        </span>
        <div role="group" aria-labelledby="cards-label" className="flex items-center gap-1 rounded-xl bg-field-deep p-1">
          <button
            type="button"
            aria-label="Fewer cards"
            disabled={cards <= CARDS_PER_PLAYER_MIN}
            onClick={() => step(-1)}
            className="size-11 rounded-lg text-2xl font-bold disabled:opacity-35"
          >
            −
          </button>
          <output aria-live="polite" className="wide w-10 text-center text-2xl font-black">
            {cards}
          </output>
          <button
            type="button"
            aria-label="More cards"
            disabled={cards >= limit}
            onClick={() => step(1)}
            className="size-11 rounded-lg text-2xl font-bold disabled:opacity-35"
          >
            +
          </button>
        </div>
      </div>
      <ActionButton tone="nailed" big disabled={!canStart} onClick={() => onStart(cards)} aria-describedby="start-reason">
        Start the game
      </ActionButton>
      {reason ? (
        <p id="start-reason" className="text-center text-lg text-white">
          {reason}
        </p>
      ) : null}
    </section>
  );
}

export function LobbyView({ room, viewerId, send }: ViewProps) {
  const viewer = findPlayer(room, viewerId);
  const status = startStatus(room, viewerId);
  const reason = status.canStart ? undefined : status.reason;
  const decks = deckCount(room);
  const origin = useOrigin();
  const host = isHost(room, viewerId);
  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className="text-field-soft">
          {origin ? `Friends go to ${roomUrls(origin, room.code).display} and enter` : "Friends join with this code"}
        </p>
        <p className="wide mt-1 font-black whitespace-nowrap tracking-[0.06em] text-[min(16vw,9rem)] leading-[0.9]">
          {room.code}
        </p>
      </section>

      <section>
        <h2 className="flex items-baseline justify-between border-b-2 border-field-soft/30 pb-2">
          <span className="wide text-2xl font-extrabold">In the room</span>
          <span className="text-field-soft">
            {room.players.length} here, {decks} {decks === 1 ? "deck" : "decks"}
          </span>
        </h2>
        <ul className="divide-y divide-field-soft/20">
          {room.players.map((player) => (
            <RosterRow key={player.id} player={player} viewerId={viewerId} />
          ))}
        </ul>
      </section>

      {viewer ? (
        <DeckPanel code={room.code} viewer={viewer} onDemo={() => send({ type: "submit_deck", deck: buildDemoDeck() })} />
      ) : null}

      {host ? (
        <HostControls
          limit={cardsPerPlayerLimit(room)}
          canStart={status.canStart}
          reason={reason}
          onStart={(cardsPerPlayer) => send({ type: "start", cardsPerPlayer })}
        />
      ) : (
        <p className="text-center text-lg text-field-soft">{reason}</p>
      )}

      {host ? <StageLink code={room.code} /> : null}
    </div>
  );
}
