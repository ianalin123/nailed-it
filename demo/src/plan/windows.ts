import type { Markers } from "../record/markers";

export type Window = { start: number; duration: number };

export type AppWindows = {
  join: Window;
  play: Window;
  playPhoneStart: number | null;
  chain: Window;
};

export const TIMING = {
  joinDelay: 100,
  joinMin: 9_000,
  joinTail: 2_000,
  joinGapBeforeVoting: 300,
  playLead: 400,
  playTail: 5_500,
  chainLead: 1_600,
  chainLength: 10_000,
  chainGapBeforeEnd: 200,
  minimumRecordingAfterReveal: 12_000,
} as const;

const assertOrder = (markers: Markers): void => {
  const sequence: Array<[string, number]> = [
    ["stage.startedAt", markers.stage.startedAt],
    ["lobbyAt", markers.lobbyAt],
    ["votingAt", markers.votingAt],
    ["revealAt", markers.revealAt],
    ["endAt", markers.endAt],
  ];
  for (let i = 1; i < sequence.length; i += 1) {
    const [prevName, prev] = sequence[i - 1] ?? ["", 0];
    const [name, value] = sequence[i] ?? ["", 0];
    if (value <= prev) {
      throw new Error(`markers.json is out of order: ${name} (${value}) must come after ${prevName} (${prev}).`);
    }
  }
};

const seconds = (ms: number): number => ms / 1000;

export const appWindows = (markers: Markers): AppWindows => {
  assertOrder(markers);
  const origin = markers.stage.startedAt;
  const joinStart = markers.lobbyAt + TIMING.joinDelay;
  const lastLobbyEvent = Math.max(markers.lobbyAt, ...markers.lobbyEvents);
  const joinEnd = Math.min(
    markers.votingAt - TIMING.joinGapBeforeVoting,
    Math.max(lastLobbyEvent + TIMING.joinTail, joinStart + TIMING.joinMin),
  );
  const playStart = markers.votingAt - TIMING.playLead;
  const playEnd = Math.min(markers.revealAt + TIMING.playTail, markers.endAt - TIMING.chainGapBeforeEnd);
  const chainStart = markers.revealAt + TIMING.chainLead;
  const chainEnd = Math.min(chainStart + TIMING.chainLength, markers.endAt - TIMING.chainGapBeforeEnd);
  if (chainEnd <= chainStart) {
    throw new Error(`markers.json endAt is too soon after revealAt: nothing left to show for beat 6.`);
  }
  const phoneShift = markers.phone === null ? null : markers.phone.startedAt - origin;
  return {
    join: { start: seconds(joinStart - origin), duration: seconds(joinEnd - joinStart) },
    play: { start: seconds(playStart - origin), duration: seconds(playEnd - playStart) },
    playPhoneStart: phoneShift === null ? null : seconds(playStart - origin - phoneShift),
    chain: { start: seconds(chainStart - origin), duration: seconds(chainEnd - chainStart) },
  };
};
