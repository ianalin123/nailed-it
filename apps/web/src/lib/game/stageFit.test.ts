import type { PresentedStep } from "./chain";
import {
  STAGE_FLOOR_U,
  estimateBlockHeight,
  fitChain,
  leaderboardColumns,
  pickTypeSize,
  resultsLayout,
  stampFootprint,
  voterRowSize,
  type ChainItem,
} from "./stageFit";

const text = (length: number): string => "word ".repeat(Math.ceil(length / 5)).slice(0, length);

describe("estimateBlockHeight", () => {
  it("grows with text length and shrinks with width", () => {
    const short = estimateBlockHeight(40, { widthU: 40 }, 2);
    const long = estimateBlockHeight(240, { widthU: 40 }, 2);
    const wide = estimateBlockHeight(240, { widthU: 80 }, 2);
    expect(long).toBeGreaterThan(short);
    expect(wide).toBeLessThan(long);
  });
});

describe("pickTypeSize", () => {
  const box = { widthU: 60, heightU: 30 };
  const steps = [4.4, 3.8, 3.2, 2.7, 2.2, 1.8];

  it("keeps short reads at the largest size", () => {
    expect(pickTypeSize(60, box, steps)).toEqual({ sizeU: 4.4, fits: true });
  });

  it("steps down for a 240-character read until it fits", () => {
    const picked = pickTypeSize(240, box, steps);
    expect(picked.fits).toBe(true);
    expect(picked.sizeU).toBeLessThan(4.4);
    expect(estimateBlockHeight(240, box, picked.sizeU)).toBeLessThanOrEqual(box.heightU);
  });

  it("never goes below the smallest step, and says when it still doesn't fit", () => {
    expect(pickTypeSize(240, { widthU: 10, heightU: 2 }, steps)).toEqual({ sizeU: 1.8, fits: false });
  });

  it("never offers a size below the readable floor", () => {
    expect(pickTypeSize(240, { widthU: 10, heightU: 2 }, [0.5]).sizeU).toBe(STAGE_FLOOR_U);
  });
});

describe("resultsLayout", () => {
  it("uses one column when everyone fits", () => {
    expect(resultsLayout(5, 6, 2)).toEqual({ columns: 1, shown: 5, hidden: 0 });
  });

  it("splits into two columns past one column's worth", () => {
    expect(resultsLayout(7, 6, 2)).toEqual({ columns: 2, shown: 7, hidden: 0 });
    expect(resultsLayout(12, 6, 2)).toEqual({ columns: 2, shown: 12, hidden: 0 });
  });

  it("shows the top rows plus a count of the rest when even two columns overflow", () => {
    expect(resultsLayout(11, 4, 2)).toEqual({ columns: 2, shown: 7, hidden: 4 });
  });

  it("uses one column with a count when only one column is allowed", () => {
    expect(resultsLayout(9, 6, 1)).toEqual({ columns: 1, shown: 5, hidden: 4 });
  });
});

describe("leaderboardColumns", () => {
  it("uses two columns past six players", () => {
    expect(leaderboardColumns(6)).toBe(1);
    expect(leaderboardColumns(7)).toBe(2);
    expect(leaderboardColumns(12)).toBe(2);
  });
});

describe("voterRowSize", () => {
  it("shrinks rows for bigger rooms but stays above the floor", () => {
    expect(voterRowSize(3)).toBeGreaterThan(voterRowSize(11));
    expect(voterRowSize(11)).toBeGreaterThanOrEqual(STAGE_FLOOR_U);
  });
});

describe("fitChain", () => {
  const box = { widthU: 36, heightU: 40 };
  const steps = (lengths: Array<[PresentedStep["kind"], number]>): PresentedStep[] =>
    lengths.map(([kind, length], order) => ({ kind, text: text(length), order }));
  const kinds = (items: ChainItem[]) => items.map((item) => (item.kind === "more" ? `more:${item.count}` : item.kind));

  it("shows every step at the largest size that fits", () => {
    const fitted = fitChain(steps([["evidence", 60], ["inference", 50], ["read", 80]]), box);
    expect(fitted.hidden).toBe(0);
    expect(kinds(fitted.items)).toEqual(["evidence", "inference", "read"]);
    expect(fitted.sizeU).toBeGreaterThan(STAGE_FLOOR_U);
  });

  it("steps type down for a six-step chain before dropping anything", () => {
    const six = steps([
      ["evidence", 90],
      ["evidence", 90],
      ["inference", 80],
      ["evidence", 90],
      ["inference", 80],
      ["inference", 80],
      ["read", 120],
    ]);
    const fitted = fitChain(six, box);
    expect(fitted.hidden).toBe(0);
    expect(fitted.sizeU).toBeLessThan(fitChain(steps([["evidence", 60], ["read", 60]]), box).sizeU);
  });

  it("keeps first evidence, last inference and the read, with a marker, when nothing else fits", () => {
    const huge = steps([
      ["evidence", 240],
      ["evidence", 240],
      ["inference", 240],
      ["evidence", 240],
      ["inference", 240],
      ["inference", 240],
      ["read", 240],
    ]);
    const fitted = fitChain(huge, box);
    expect(fitted.sizeU).toBe(STAGE_FLOOR_U);
    expect(fitted.hidden).toBeGreaterThan(0);
    const shown = kinds(fitted.items);
    expect(shown[0]).toBe("evidence");
    expect(shown.slice(-3)).toEqual([`more:${fitted.hidden}`, "inference", "read"]);
    const lastInference = fitted.items.at(-2);
    expect(lastInference?.kind === "inference" && lastInference.order).toBe(5);
    expect(fitted.heightU).toBeLessThanOrEqual(box.heightU);
  });

  it("returns nothing for an empty chain", () => {
    expect(fitChain([], box)).toEqual({ sizeU: STAGE_FLOOR_U, items: [], hidden: 0, heightU: 0 });
  });
});

describe("stampFootprint", () => {
  it("is wider for longer labels", () => {
    const nailed = stampFootprint("Nailed it", 2.8, 0);
    const partly = stampFootprint("Partly", 2.8, 0);
    expect(nailed.widthU).toBeGreaterThan(partly.widthU);
  });

  it("grows its bounding box when rotated", () => {
    const flat = stampFootprint("Nailed it", 2.8, 0);
    const tilted = stampFootprint("Nailed it", 2.8, -5);
    expect(tilted.heightU).toBeGreaterThan(flat.heightU);
    expect(tilted.widthU).toBeGreaterThanOrEqual(flat.widthU * Math.cos((5 * Math.PI) / 180));
  });

  it("is symmetric in tilt direction", () => {
    expect(stampFootprint("Way off", 2.8, 4)).toEqual(stampFootprint("Way off", 2.8, -4));
  });
});
