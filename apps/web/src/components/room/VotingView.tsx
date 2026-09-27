"use client";

import { useState } from "react";
import type { Guess, Truth } from "@nailed-it/protocol";
import {
  GUESS_LABEL,
  TRUTH_LABEL,
  canGuess,
  canReveal,
  guessers,
  hasVoted,
  hotSeatPlayer,
  roundLabel,
  voteProgress,
} from "@/lib/game/selectors";
import { ActionButton } from "../ActionButton";
import { Slip } from "../Slip";
import { HotSeatHeading } from "./HotSeatHeading";
import { VoterStrip } from "./VoterStrip";
import type { ViewProps } from "./types";

type LocalGuess = { readId: string; guess: Guess };

const GUESS_ORDER: readonly Guess[] = ["nailed", "off"];
const TRUTH_ORDER: readonly Truth[] = ["nailed", "partly", "off"];

function GuessPad({ selected, alreadyVoted, hotSeatName, onGuess }: {
  selected: Guess | undefined;
  alreadyVoted: boolean;
  hotSeatName: string;
  onGuess: (guess: Guess) => void;
}) {
  const hint = selected
    ? `You can change your guess until ${hotSeatName} reveals.`
    : alreadyVoted
      ? "Your guess is in. Tap again to change it."
      : "Did the reader get it right?";
  return (
    <section className="flex flex-col gap-3" aria-label="Your guess">
      <div className="grid grid-cols-2 gap-3">
        {GUESS_ORDER.map((guess) => (
          <ActionButton
            key={guess}
            tone={guess}
            big
            selected={selected === guess}
            aria-pressed={selected === guess}
            onClick={() => onGuess(guess)}
          >
            {GUESS_LABEL[guess]}
          </ActionButton>
        ))}
      </div>
      <p className="text-center text-field-soft">{hint}</p>
    </section>
  );
}

function RevealPad({ voted, eligible, onReveal }: { voted: number; eligible: number; onReveal: (truth: Truth) => void }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Reveal the truth">
      <p className="text-lg">
        <span className="font-bold">
          {voted} of {eligible}
        </span>{" "}
        <span className="text-field-soft">have guessed. When you&apos;re ready, tell them the truth.</span>
      </p>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {TRUTH_ORDER.map((truth) => (
          <ActionButton key={truth} tone={truth} big className="px-1 text-[clamp(1rem,4.8vw,1.8rem)]" onClick={() => onReveal(truth)}>
            {TRUTH_LABEL[truth]}
          </ActionButton>
        ))}
      </div>
    </section>
  );
}

export function VotingView({ room, viewerId, send }: ViewProps) {
  const [local, setLocal] = useState<LocalGuess | undefined>(undefined);
  const round = room.round;
  if (!round) return null;
  const hotSeat = hotSeatPlayer(room);
  const progress = voteProgress(room);
  const selected = local?.readId === round.read.id ? local.guess : undefined;

  const guess = (value: Guess) => {
    setLocal({ readId: round.read.id, guess: value });
    send({ type: "guess", readId: round.read.id, guess: value });
  };

  return (
    <div className="flex flex-col gap-6">
      <HotSeatHeading hotSeat={hotSeat} viewerId={viewerId} />
      <Slip feedKey={round.read.id} header={roundLabel(round)}>
        {round.read.text}
      </Slip>
      {canGuess(room, viewerId) ? (
        <GuessPad
          selected={selected}
          alreadyVoted={viewerId !== undefined && hasVoted(room, viewerId)}
          hotSeatName={hotSeat?.nickname ?? "the hot seat"}
          onGuess={guess}
        />
      ) : null}
      {canReveal(room, viewerId) ? (
        <RevealPad
          voted={progress.voted}
          eligible={progress.eligible}
          onReveal={(truth) => send({ type: "reveal", readId: round.read.id, truth })}
        />
      ) : null}
      <VoterStrip voters={guessers(room)} votedIds={round.votedPlayerIds} viewerId={viewerId} />
    </div>
  );
}
