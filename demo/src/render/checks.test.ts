import { describe, expect, it } from "vitest";
import { flatGrayFraction } from "./checks";

const pixels = (...rgb: Array<[number, number, number]>): Buffer => Buffer.from(rgb.flat());

describe("flatGrayFraction", () => {
  it("counts Playwright's gray padding", () => {
    expect(flatGrayFraction(pixels([128, 128, 128], [127, 129, 128], [43, 63, 224], [242, 244, 243]))).toBe(0.5);
  });

  it("is zero for the app's palette", () => {
    const palette: Array<[number, number, number]> = [
      [43, 63, 224],
      [29, 43, 171],
      [201, 208, 255],
      [242, 244, 243],
      [18, 26, 92],
      [255, 61, 127],
    ];
    expect(flatGrayFraction(pixels(...palette))).toBe(0);
  });

  it("rejects a buffer that is not whole RGB pixels", () => {
    expect(() => flatGrayFraction(Buffer.from([1, 2]))).toThrow(/RGB/);
  });
});
