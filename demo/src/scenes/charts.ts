const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

export const niceCeil = (value: number): number => {
  if (!(value > 0)) throw new Error(`niceCeil needs a positive value, got ${value}`);
  const power = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((s) => s * power >= value - 1e-12) ?? 10;
  return Number((step * power).toPrecision(12));
};

export type Bar = { value: number; from: number; to: number };
export type BarChart = { domain: [number, number]; zeroX: number; unitWidth: number; bars: Bar[] };

export const barGeometry = (values: readonly number[], width: number): BarChart => {
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const domainLow = low < 0 ? -niceCeil(-low) : 0;
  const domainHigh = high > 0 ? niceCeil(high) : 0;
  const top = domainHigh === domainLow ? domainLow + 1 : domainHigh;
  const unitWidth = width / (top - domainLow);
  const x = (v: number): number => (v - domainLow) * unitWidth;
  const zeroX = x(0);
  return { domain: [domainLow, top], zeroX, unitWidth, bars: values.map((value) => ({ value, from: zeroX, to: x(value) })) };
};

export type Interval = { value: number; ciLow: number; ciHigh: number };
export type IntervalChart = { zeroX: number; lowX: number; valueX: number; highX: number; domain: [number, number] };

const INTERVAL_MARGIN = 0.12;

export const intervalGeometry = (interval: Interval, width: number): IntervalChart => {
  const low = Math.min(0, interval.ciLow);
  const high = Math.max(0, interval.ciHigh);
  const pad = (high - low || 1) * INTERVAL_MARGIN;
  const domain: [number, number] = [low - pad, high + pad];
  const x = (v: number): number => ((v - domain[0]) / (domain[1] - domain[0])) * width;
  return { zeroX: x(0), lowX: x(interval.ciLow), valueX: x(interval.value), highX: x(interval.ciHigh), domain };
};

export const decimalsOf = (n: number): number => {
  const text = String(n);
  if (text.includes("e")) return 6;
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
};

export const shownDecimals = (values: readonly number[]): number => Math.min(6, Math.max(2, ...values.map(decimalsOf)));

export const formatValue = (value: number, decimals: number): string => value.toFixed(decimals);

export const formatSigned = (value: number, decimals: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}`;
