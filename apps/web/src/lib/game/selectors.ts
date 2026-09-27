import {
  MIN_PLAYERS,
  type Guess,
  type Player,
  type RoomState,
  type Round,
  type Truth,
} from "@nailed-it/protocol";

export const MIN_DECKS = 2;
export const CARDS_PER_PLAYER_MIN = 1;
export const CARDS_PER_PLAYER_MAX = 10;
export const CARDS_PER_PLAYER_DEFAULT = 3;

export type Screen = "lobby" | "voting" | "reveal" | "dealing" | "finished";

export const screenFor = (state: RoomState): Screen => {
  if (state.status === "lobby") return "lobby";
  if (state.status === "finished") return "finished";
  if (!state.round) return "dealing";
  return state.round.phase;
};

export const findPlayer = (state: RoomState, playerId: string | undefined): Player | undefined =>
  playerId === undefined ? undefined : state.players.find((player) => player.id === playerId);

export const isHost = (state: RoomState, playerId: string | undefined): boolean =>
  findPlayer(state, playerId)?.isHost ?? false;

export const hostOf = (state: RoomState): Player | undefined =>
  state.players.find((player) => player.isHost);

export const deckCount = (state: RoomState): number =>
  state.players.filter((player) => player.hasDeck).length;

export type StartStatus = { canStart: true } | { canStart: false; reason: string };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export const startStatus = (state: RoomState, viewerId: string | undefined): StartStatus => {
  if (state.status !== "lobby") return { canStart: false, reason: "The game has already started." };
  if (!isHost(state, viewerId)) {
    const host = hostOf(state);
    return {
      canStart: false,
      reason: host ? `Waiting for ${host.nickname} to start.` : "Waiting for a host.",
    };
  }
  const players = state.players.length;
  if (players < MIN_PLAYERS) {
    return {
      canStart: false,
      reason: `Needs at least ${MIN_PLAYERS} players. ${plural(players, "player")} here so far.`,
    };
  }
  const decks = deckCount(state);
  if (decks < MIN_DECKS) {
    return {
      canStart: false,
      reason: `Needs at least ${MIN_DECKS} decks. ${decks === 0 ? "None" : decks} in so far.`,
    };
  }
  return { canStart: true };
};

export const clampCardsPerPlayer = (value: number): number =>
  Math.min(CARDS_PER_PLAYER_MAX, Math.max(CARDS_PER_PLAYER_MIN, Math.round(value)));

export type ViewerRole = "hot_seat" | "guesser" | "spectator";

export const viewerRole = (state: RoomState, viewerId: string | undefined): ViewerRole => {
  const viewer = findPlayer(state, viewerId);
  if (!viewer || !state.round) return "spectator";
  return state.round.hotSeatPlayerId === viewer.id ? "hot_seat" : "guesser";
};

const inVoting = (state: RoomState): state is RoomState & { round: Round } =>
  state.status === "playing" && state.round?.phase === "voting";

export const canGuess = (state: RoomState, viewerId: string | undefined): boolean =>
  inVoting(state) && viewerRole(state, viewerId) === "guesser";

export const canReveal = (state: RoomState, viewerId: string | undefined): boolean =>
  inVoting(state) && viewerRole(state, viewerId) === "hot_seat";

export const canAdvance = (state: RoomState, viewerId: string | undefined): boolean =>
  state.status === "playing" && state.round?.phase === "reveal" && isHost(state, viewerId);

export const hotSeatPlayer = (state: RoomState): Player | undefined =>
  state.round ? findPlayer(state, state.round.hotSeatPlayerId) : undefined;

export const guessers = (state: RoomState): Player[] =>
  state.round
    ? state.players.filter((player) => player.id !== state.round?.hotSeatPlayerId)
    : [];

export const hasVoted = (state: RoomState, playerId: string): boolean =>
  state.round?.votedPlayerIds.includes(playerId) ?? false;

export type VoteProgress = { voted: number; eligible: number; allIn: boolean };

export const voteProgress = (state: RoomState): VoteProgress => {
  const eligible = guessers(state);
  const voted = eligible.filter((player) => hasVoted(state, player.id)).length;
  return { voted, eligible: eligible.length, allIn: eligible.length > 0 && voted === eligible.length };
};

export type GuessOutcome = "correct" | "wrong" | "partly" | "no_guess";

export const guessOutcome = (guess: Guess | undefined, truth: Truth): GuessOutcome => {
  if (guess === undefined) return "no_guess";
  if (truth === "partly") return "partly";
  return guess === truth ? "correct" : "wrong";
};

export type RevealRow = {
  player: Player;
  guess: Guess | undefined;
  outcome: GuessOutcome;
  points: number;
};

export type RevealSummary = {
  truth: Truth;
  readerConfidence: number | undefined;
  rows: RevealRow[];
};

export const revealSummary = (state: RoomState): RevealSummary | undefined => {
  const round = state.round;
  if (!round || round.phase !== "reveal" || round.truth === undefined) return undefined;
  const truth = round.truth;
  const rows = guessers(state).map((player): RevealRow => {
    const guess = round.guesses?.[player.id];
    return {
      player,
      guess,
      outcome: guessOutcome(guess, truth),
      points: round.pointsAwarded?.[player.id] ?? 0,
    };
  });
  return { truth, readerConfidence: round.readerConfidence, rows };
};

export type LeaderboardEntry = { rank: number; player: Player };

export const leaderboard = (players: readonly Player[]): LeaderboardEntry[] => {
  const sorted = [...players].sort(
    (a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname),
  );
  return sorted.reduce<LeaderboardEntry[]>((entries, player, index) => {
    const previous = entries[index - 1];
    const rank = previous && previous.player.score === player.score ? previous.rank : index + 1;
    return [...entries, { rank, player }];
  }, []);
};

export const formatPercent = (fraction: number): string =>
  `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

export const confidenceLine = (confidence: number | undefined): string | undefined =>
  confidence === undefined ? undefined : `The reader was ${formatPercent(confidence)} sure.`;

export const accuracyLine = (accuracy: number | undefined): string =>
  accuracy === undefined
    ? "The reader's accuracy wasn't reported for this game."
    : `The reader got ${formatPercent(accuracy)} of its reads right.`;

export const TRUTH_LABEL: Record<Truth, string> = {
  nailed: "Nailed it",
  partly: "Partly",
  off: "Way off",
};

export const GUESS_LABEL: Record<Guess, string> = {
  nailed: "Nailed it",
  off: "Way off",
};

export const roundLabel = (round: Round): string => `Card ${round.index + 1} of ${round.total}`;

export const possessive = (name: string): string => (name.endsWith("s") ? `${name}'` : `${name}'s`);
