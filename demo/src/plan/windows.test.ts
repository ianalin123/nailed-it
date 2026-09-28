import { describe, expect, it } from "vitest";
import type { Markers } from "../record/markers";
import { appWindows, revealFraction } from "./windows";

const markers = (overrides: Partial<Markers> = {}): Markers => ({
  mode: "real",
  roomCode: "ABCD",
  stage: { file: "stage.webm", startedAt: 1_000 },
  phone: { file: "phone.webm", startedAt: 1_500, nickname: "Theo" },
  lobbyAt: 3_000,
  lobbyEvents: [4_000, 5_000, 8_000],
  votingAt: 14_000,
  revealAt: 26_000,
  endAt: 42_000,
  chainBox: { x: 1000, y: 150, width: 820, height: 420 },
  ...overrides,
});

describe("appWindows", () => {
  it("starts the join beat just after the lobby shows, in stage video time", () => {
    const w = appWindows(markers());
    expect(w.join.start).toBeCloseTo(2.1);
  });

  it("holds the join beat past the last lobby event but stops before voting", () => {
    const w = appWindows(markers());
    const end = w.join.start + w.join.duration;
    expect(end).toBeGreaterThanOrEqual((8_000 + 1_500 - 1_000) / 1000);
    expect(end).toBeLessThanOrEqual((14_000 - 1_000) / 1000);
  });

  it("runs play from the moment the card appears to after the reveal, so it never opens on the lobby", () => {
    const w = appWindows(markers());
    expect(w.play.start).toBeCloseTo((14_000 - 1_000) / 1000);
    expect(w.play.start + w.play.duration).toBeCloseTo((26_000 + 5_500 - 1_000) / 1000);
  });

  it("shifts the phone window by the difference in video start times", () => {
    const w = appWindows(markers());
    expect(w.playPhoneStart).toBeCloseTo(w.play.start - 0.5);
  });

  it("has no phone window without a phone recording", () => {
    expect(appWindows(markers({ phone: null })).playPhoneStart).toBeNull();
  });

  it("starts how-it-knew after the reveal and never runs past the recording", () => {
    const w = appWindows(markers({ endAt: 34_000 }));
    expect(w.chain.start).toBeCloseTo((26_000 + 2_200 - 1_000) / 1000);
    expect(w.chain.start + w.chain.duration).toBeLessThanOrEqual((34_000 - 1_000) / 1000);
  });

  it("fails loudly when markers are out of order", () => {
    expect(() => appWindows(markers({ revealAt: 10_000 }))).toThrow(/revealAt/);
  });
});

describe("revealFraction", () => {
  it("puts the stamp about two thirds through the play beat of the first real recording", () => {
    const real = markers({
      stage: { file: "stage.webm", startedAt: 1790554219036 },
      phone: { file: "phone.webm", startedAt: 1790554221116, nickname: "Theo" },
      lobbyAt: 1790554219630,
      lobbyEvents: [1790554226104],
      votingAt: 1790554229332,
      revealAt: 1790554240975,
      endAt: 1790554253498,
    });
    const fraction = revealFraction(real);
    expect(fraction).toBeGreaterThan(0.6);
    expect(fraction).toBeLessThan(0.75);
  });

  it("keeps how-it-knew short enough that the finished chain does not sit static for long", () => {
    expect(appWindows(markers()).chain.duration).toBeLessThanOrEqual(7);
  });
});
