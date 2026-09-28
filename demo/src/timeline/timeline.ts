export type Ease = (x: number) => number;

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

const bezierPoint = (a: number, b: number, s: number): number => 3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;

const bezierSlope = (a: number, b: number, s: number): number =>
  3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s ** 2;

const solveForX = (x1: number, x2: number, x: number): number => {
  let s = x;
  for (let i = 0; i < 8; i += 1) {
    const slope = bezierSlope(x1, x2, s);
    if (Math.abs(slope) < 1e-6) break;
    s -= (bezierPoint(x1, x2, s) - x) / slope;
  }
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30 && Math.abs(bezierPoint(x1, x2, s) - x) > 1e-6; i += 1) {
    s = (low + high) / 2;
    if (bezierPoint(x1, x2, s) < x) low = s;
    else high = s;
  }
  return s;
};

export const cubicBezier =
  (x1: number, y1: number, x2: number, y2: number): Ease =>
  (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return bezierPoint(y1, y2, solveForX(x1, x2, x));
  };

export const easeOut: Ease = cubicBezier(0.2, 0.8, 0.2, 1);
export const easeInOut: Ease = cubicBezier(0.65, 0, 0.35, 1);

export const progress = (t: number, start: number, duration: number): number => {
  if (duration <= 0) return t >= start ? 1 : 0;
  return clamp01((t - start) / duration);
};

export const typed = (text: string, t: number, start: number, charsPerSecond: number): string => {
  const shown = Math.floor(Math.max(0, t - start) * charsPerSecond);
  return Array.from(text).slice(0, shown).join("");
};

export const typingDuration = (text: string, charsPerSecond: number): number => Array.from(text).length / charsPerSecond;

export const countUp = (from: number, to: number, amount: number): number => Math.floor(lerp(from, to, clamp01(amount)) + 1e-9);

export const frameCount = (durationSeconds: number, fps: number): number => {
  if (!(durationSeconds > 0)) throw new Error(`Scene duration must be positive, got ${durationSeconds}`);
  return Math.round(durationSeconds * fps);
};

export const frameTime = (frame: number, fps: number): number => frame / fps;
