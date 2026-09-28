import { describe, expect, it } from "vitest";
import { FRAME, PLAY_LAYOUT, even, fitInto, phoneCrop, spotlight } from "./layout";

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

describe("PLAY_LAYOUT", () => {
  it("keeps the stage and phone apart and inside the frame", () => {
    const { stage, phone } = PLAY_LAYOUT;
    expect(stage.x + stage.width).toBeLessThan(phone.x);
    expect(phone.y + phone.height).toBeLessThanOrEqual(FRAME.height);
    expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2);
    expect(phone.width / phone.height).toBeCloseTo(390 / 844, 2);
  });
});

describe("phoneCrop", () => {
  const viewport = { width: 390, height: 844 };

  it("needs no crop when the video matches the viewport", () => {
    expect(phoneCrop({ width: 390, height: 844 }, viewport)).toBeNull();
  });

  it("crops the top-left viewport region out of a padded video", () => {
    expect(phoneCrop({ width: 780, height: 1688 }, viewport)).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  });

  it("refuses a video smaller than the viewport", () => {
    expect(() => phoneCrop({ width: 300, height: 600 }, viewport)).toThrow(/smaller than the phone viewport/);
  });
});

describe("spotlight", () => {
  it("pads the chain box and keeps it inside the frame", () => {
    const hole = spotlight({ x: 1113.6, y: 107.5, width: 748.8, height: 759.9 }, FRAME, 24);
    expect(hole).toEqual({ x: 1090, y: 84, width: 796, height: 807 });
    expect(hole.x + hole.width).toBeLessThanOrEqual(FRAME.width);
  });

  it("clamps at the frame edge", () => {
    const hole = spotlight({ x: 1890, y: 5, width: 100, height: 50 }, FRAME, 24);
    expect(hole.x + hole.width).toBe(FRAME.width);
    expect(hole.y).toBe(0);
  });
});
