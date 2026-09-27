"use client";

import { useEffect, useState } from "react";
import type { Player } from "@nailed-it/protocol";
import { buildDemoDeck } from "@/lib/game/demoDeck";
import {
  CARDS_PER_PLAYER_DEFAULT,
  CARDS_PER_PLAYER_MAX,
  CARDS_PER_PLAYER_MIN,
  clampCardsPerPlayer,
  deckCount,
  findPlayer,
  isHost,
  startStatus,
} from "@/lib/game/selectors";
import { ActionButton } from "../ActionButton";
import { cx } from "../cx";
import { PlayerName } from "./PlayerName";
import type { ViewProps } from "./types";

export const pluginCommand = (code: string): string => `/nailed-it:read ${code}`;

const useJoinAddress = (): string | undefined => {
  const [address, setAddress] = useState<string | undefined>(undefined);
  useEffect(() => setAddress(window.location.host), []);
  return address;
};

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
        <span className="shrink-0 text-sm text-field-soft">Waiting on deck</span>
      )}
    </li>
  );
}

type CopyState = { kind: "idle" } | { kind: "copied" } | { kind: "failed"; reason: string };

function CommandToCopy({ command }: { command: string }) {
  const [copy, setCopy] = useState<CopyState>({ kind: "idle" });
  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy({ kind: "copied" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setCopy({ kind: "failed", reason });
    }
  };
  return (
    <div>
      <div className="flex items-stretch overflow-hidden rounded-xl bg-ink">
        <code className="min-w-0 flex-1 overflow-x-auto px-4 py-3 font-machine text-lg whitespace-nowrap text-slip">
          {command}
        </code>
        <button type="button" onClick={copyCommand} className="shrink-0 bg-slip px-4 font-bold text-ink">
          {copy.kind === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {copy.kind === "failed" ? (
        <p role="alert" className="mt-2 text-sm text-alarm">
          Couldn&apos;t copy ({copy.reason}). Select the command and copy it by hand.
        </p>
      ) : null}
    </div>
  );
}

function DeckPanel({ code, hasDeck, onDemo }: { code: string; hasDeck: boolean; onDemo: () => void }) {
  if (hasDeck) {
    return (
      <section className="rounded-2xl bg-field-deep p-5">
        <h2 className="wide text-2xl font-extrabold">Your deck is in</h2>
        <p className="mt-1 text-field-soft">The reader has its guesses about you. Nobody sees them until the game starts.</p>
      </section>
    );
  }
  return (
    <section className="rounded-2xl bg-field-deep p-5">
      <h2 className="wide text-2xl font-extrabold">Get read</h2>
      <p className="mt-1 mb-4 max-w-prose text-field-soft">
        Run this in Claude Code on your own computer. The reader looks at your files there, you approve what it
        uses, and only its reads come to this room.
      </p>
      <CommandToCopy command={pluginCommand(code)} />
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <ActionButton tone="quiet" onClick={onDemo} className="border-2 border-field-soft/40 sm:w-auto">
          Use demo deck
        </ActionButton>
        <p className="text-sm text-field-soft">Reads about a made-up person, so you can play without the plugin.</p>
      </div>
    </section>
  );
}

function HostControls({ canStart, reason, onStart }: { canStart: boolean; reason: string | undefined; onStart: (cards: number) => void }) {
  const [cards, setCards] = useState(CARDS_PER_PLAYER_DEFAULT);
  const step = (delta: number) => setCards((value) => clampCardsPerPlayer(value + delta));
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
            disabled={cards >= CARDS_PER_PLAYER_MAX}
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
        <p id="start-reason" className="text-center text-field-soft">
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
  const joinAddress = useJoinAddress();
  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className="text-field-soft">
          {joinAddress ? `Friends go to ${joinAddress} and enter` : "Friends join with this code"}
        </p>
        <p className="wide mt-1 font-black tracking-[0.12em] text-[clamp(4.5rem,24vw,9rem)] leading-[0.9]">{room.code}</p>
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
        <DeckPanel
          code={room.code}
          hasDeck={viewer.hasDeck}
          onDemo={() => send({ type: "submit_deck", deck: buildDemoDeck() })}
        />
      ) : null}

      {isHost(room, viewerId) ? (
        <HostControls
          canStart={status.canStart}
          reason={reason}
          onStart={(cardsPerPlayer) => send({ type: "start", cardsPerPlayer })}
        />
      ) : (
        <p className="text-center text-lg text-field-soft">{reason}</p>
      )}
    </div>
  );
}
