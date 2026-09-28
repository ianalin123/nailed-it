const GRAY_TOLERANCE = 6;
const PAD_GRAY = 128;

export const flatGrayFraction = (rgb: Buffer): number => {
  if (rgb.length === 0 || rgb.length % 3 !== 0) throw new Error(`Expected whole RGB pixels, got ${rgb.length} bytes`);
  let gray = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] ?? 0;
    const g = rgb[i + 1] ?? 0;
    const b = rgb[i + 2] ?? 0;
    const near = (v: number): boolean => Math.abs(v - PAD_GRAY) <= GRAY_TOLERANCE;
    if (near(r) && near(g) && near(b)) gray += 1;
  }
  return gray / (rgb.length / 3);
};
