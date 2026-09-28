import { describe, expect, it } from "vitest";
import { barGeometry, decimalsOf, formatSigned, formatValue, intervalGeometry, niceCeil, shownDecimals } from "./charts";
import { easeOut } from "../timeline/timeline";

describe("niceCeil", () => {
  it("rounds up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceCeil(0.169)).toBe(0.2);
    expect(niceCeil(0.054)).toBe(0.1);
    expect(niceCeil(1.4)).toBe(2);
    expect(niceCeil(2.2)).toBe(2.5);
    expect(niceCeil(3)).toBe(5);
  });

  it("rejects values that are not positive", () => {
    expect(() => niceCeil(0)).toThrow(/positive/);
  });
});

describe("barGeometry", () => {
  const bars = barGeometry([0.054, 0.169], 1000);

  it("starts every bar at the zero baseline", () => {
    expect(bars.zeroX).toBe(0);
    for (const bar of bars.bars) expect(bar.from).toBe(0);
  });

  it("uses one scale for both bars, so lengths are proportional to the values", () => {
    const [base, trained] = bars.bars;
    expect(trained!.to / base!.to).toBeCloseTo(0.169 / 0.054, 6);
  });

  it("has an axis maximum that is a nice number at or above the largest value", () => {
    expect(bars.domain).toEqual([0, 0.2]);
    expect(bars.bars[1]!.to).toBeCloseTo((0.169 / 0.2) * 1000);
  });

  it("draws a negative value to the left of a visible zero, on the same scale", () => {
    const mixed = barGeometry([-0.05, 0.15], 1000);
    expect(mixed.domain[0]).toBeLessThan(0);
    expect(mixed.zeroX).toBeGreaterThan(0);
    const [neg, pos] = mixed.bars;
    expect(neg!.to).toBeLessThan(mixed.zeroX);
    expect((mixed.zeroX - neg!.to) / (pos!.to - mixed.zeroX)).toBeCloseTo(0.05 / 0.15, 6);
  });
});

describe("intervalGeometry", () => {
  const g = intervalGeometry({ value: 0.114, ciLow: 0.001, ciHigh: 0.227 }, 1000);

  it("always includes zero on the axis", () => {
    expect(g.zeroX).toBeGreaterThanOrEqual(0);
    expect(g.zeroX).toBeLessThanOrEqual(1000);
  });

  it("orders zero, low, point and high left to right for a barely positive interval", () => {
    expect(g.zeroX).toBeLessThan(g.lowX);
    expect(g.lowX).toBeLessThan(g.valueX);
    expect(g.valueX).toBeLessThan(g.highX);
  });

  it("shows how close the low end comes to zero on a linear scale", () => {
    const perUnit = (g.highX - g.lowX) / (0.227 - 0.001);
    expect(g.lowX - g.zeroX).toBeCloseTo(0.001 * perUnit, 6);
  });

  it("keeps everything inside the width with margin", () => {
    expect(Math.min(g.zeroX, g.lowX)).toBeGreaterThan(0);
    expect(Math.max(g.zeroX, g.highX)).toBeLessThan(1000);
  });

  it("includes zero when the whole interval is negative", () => {
    const neg = intervalGeometry({ value: -0.2, ciLow: -0.3, ciHigh: -0.1 }, 1000);
    expect(neg.highX).toBeLessThan(neg.zeroX);
  });
});

describe("no overshoot", () => {
  it("the bar easing never passes its final value", () => {
    for (let i = 0; i <= 100; i += 1) expect(easeOut(i / 100)).toBeLessThanOrEqual(1);
  });
});

describe("number formatting", () => {
  it("counts the decimals a number was written with", () => {
    expect(decimalsOf(0.054)).toBe(3);
    expect(decimalsOf(1.4)).toBe(1);
    expect(decimalsOf(2)).toBe(0);
  });

  it("shows every value at the precision of the most precise one, at least two places", () => {
    expect(shownDecimals([0.054, 0.169, 0.114])).toBe(3);
    expect(shownDecimals([1.4, 0.02])).toBe(2);
    expect(formatValue(0.054, 3)).toBe("0.054");
    expect(formatSigned(0.114, 3)).toBe("+0.114");
    expect(formatSigned(-0.05, 3)).toBe("-0.050");
  });
});
