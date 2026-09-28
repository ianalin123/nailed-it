import { describe, expect, it } from "vitest";
import { cubicBezier, frameCount, frameTime, progress, typed, countUp } from "./timeline";
import { feedAt, stampAt } from "./motion";

describe("cubicBezier", () => {
  it("pins the endpoints", () => {
    const ease = cubicBezier(0.2, 0.8, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });

  it("matches linear for a linear curve", () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    for (const x of [0.1, 0.25, 0.5, 0.9]) expect(linear(x)).toBeCloseTo(x, 4);
  });

  it("overshoots for the stamp curve", () => {
    const stamp = cubicBezier(0.2, 1.4, 0.4, 1);
    const peak = Math.max(...Array.from({ length: 99 }, (_, i) => stamp((i + 1) / 100)));
    expect(peak).toBeGreaterThan(1);
  });
});

describe("progress", () => {
  it("is 0 before the start and 1 after the end", () => {
    expect(progress(0.5, 1, 2)).toBe(0);
    expect(progress(3.5, 1, 2)).toBe(1);
    expect(progress(2, 1, 2)).toBeCloseTo(0.5);
  });

  it("treats a zero duration as a step", () => {
    expect(progress(0.99, 1, 0)).toBe(0);
    expect(progress(1, 1, 0)).toBe(1);
  });
});

describe("typed", () => {
  it("reveals characters at a fixed rate from the start time", () => {
    expect(typed("hello", 0, 1, 10)).toBe("");
    expect(typed("hello", 1.25, 1, 10)).toBe("he");
    expect(typed("hello", 10, 1, 10)).toBe("hello");
  });
});

describe("countUp", () => {
  it("interpolates whole numbers and holds the end value", () => {
    expect(countUp(10, 20, 0)).toBe(10);
    expect(countUp(10, 20, 0.5)).toBe(15);
    expect(countUp(10, 20, 1)).toBe(20);
    expect(countUp(10, 11, 0.49)).toBe(10);
  });
});

describe("frames", () => {
  it("counts frames for a duration and maps a frame to its time", () => {
    expect(frameCount(6, 30)).toBe(180);
    expect(frameCount(0.5, 30)).toBe(15);
    expect(frameTime(45, 30)).toBeCloseTo(1.5);
  });

  it("rejects durations that are not positive", () => {
    expect(() => frameCount(0, 30)).toThrow(/duration/);
  });
});

describe("stampAt", () => {
  it("is hidden before it lands and settles at the tilt", () => {
    expect(stampAt(0.9, 1, -9).opacity).toBe(0);
    const settled = stampAt(2, 1, -9);
    expect(settled.scale).toBeCloseTo(1);
    expect(settled.rotate).toBeCloseTo(-9);
    expect(settled.opacity).toBeCloseTo(0.94);
  });

  it("starts large, like a stamp coming down", () => {
    expect(stampAt(1.001, 1, -9).scale).toBeGreaterThan(1.8);
  });
});

describe("feedAt", () => {
  it("feeds the slip from fully clipped to fully shown", () => {
    expect(feedAt(0, 1).clipBottom).toBe(100);
    expect(feedAt(5, 1).clipBottom).toBeCloseTo(0);
    expect(feedAt(5, 1).translateY).toBeCloseTo(0);
  });
});
