import { describe, expect, it } from "vitest";
import { FRAME, PLAY_LAYOUT, cropForChain, even, fitInto } from "./layout";

describe("fitInto", () => {
  it("fits by width and centres vertically", () => {
    expect(fitInto({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 960, height: 1000 })).toEqual({
      x: 0,
      y: 230,
      width: 960,
      height: 540,
    });
  });

  it("returns even sizes for yuv420p", () => {
    const box = fitInto({ width: 1000, height: 333 }, { x: 0, y: 0, width: 777, height: 777 });
    expect(box.width % 2).toBe(0);
    expect(box.height % 2).toBe(0);
  });
});

describe("even", () => {
  it("rounds down to an even integer", () => {
    expect(even(11.7)).toBe(10);
    expect(even(12)).toBe(12);
  });
});

describe("cropForChain", () => {
  const target = { x: 80, y: 60, width: 1760, height: 880 };

  it("matches the target aspect and contains the chain", () => {
    const box = { x: 1000, y: 150, width: 820, height: 420 };
    const crop = cropForChain(box, FRAME, target, 1.8);
    expect(crop.width / crop.height).toBeCloseTo(2, 1);
    expect(crop.x).toBeLessThanOrEqual(box.x);
    expect(crop.y).toBeLessThanOrEqual(box.y);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(box.x + box.width);
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(box.y + box.height);
  });

  it("stays inside the frame", () => {
    const crop = cropForChain({ x: 1500, y: 900, width: 400, height: 170 }, FRAME, target, 1.8);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(FRAME.width);
    expect(crop.y + crop.height).toBeLessThanOrEqual(FRAME.height);
  });

  it("limits upscaling so a small chain is not blown up past the limit", () => {
    const crop = cropForChain({ x: 900, y: 300, width: 200, height: 100 }, FRAME, target, 1.8);
    expect(target.width / crop.width).toBeLessThanOrEqual(1.8 + 1e-6);
  });
});

describe("PLAY_LAYOUT", () => {
  it("keeps the stage and phone apart and inside the frame", () => {
    const { stage, phone } = PLAY_LAYOUT;
    expect(stage.x + stage.width).toBeLessThan(phone.x);
    expect(phone.y + phone.height).toBeLessThanOrEqual(FRAME.height);
    expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2);
    expect(phone.width / phone.height).toBeCloseTo(390 / 844, 2);
  });
});
