import type { Results } from "../data/results";
import { fadeStyle, feedAt, feedStyle } from "../timeline/motion";
import { easeOut, lerp, progress, typed, typingDuration } from "../timeline/timeline";
import { barGeometry, formatSigned, formatValue, intervalGeometry, shownDecimals, type BarChart } from "./charts";
import { caretOn, slip } from "./parts";
import { escapeHtml, type Scene } from "./scene";

type Horoscope = NonNullable<Results["horoscopeTest"]>;
type Difference = NonNullable<Horoscope["difference"]>;
type Side = "base" | "trained";

export const HOROSCOPE_COPY = {
  title: "The horoscope test",
  subtitle: "Same evidence. Two readers.",
  numbersTitle: "Did training help?",
  numbersSubtitle: "Information gain per read, base model against the trained reader.",
  barLabel: "Information gain over the base rate",
  intervalLabel: "Trained minus base, with its 95% interval",
  readsFooter: "A read that fits everyone earns nothing.",
  gainFooter: "A small gain. Measured on data it never saw.",
  noGainFooter: "No clear gain. Measured on data it never saw.",
  lossFooter: "A loss. Measured on data it never saw.",
  plainFooter: "Measured on data it never saw.",
  intervalWords: (value: string, low: string, high: string, unit: string) =>
    `Difference ${value} ${unit}. 95% interval ${low} to ${high}.`,
} as const;

const SIDES: readonly Side[] = ["base", "trained"];
const TYPE_AT = 1.1;
const CPS = 36;
const BAR_GROW = 1.1;
const INTERVAL_GROW = 0.9;

const hasBothReads = (test: Horoscope): boolean => test.base.read !== null && test.trained.read !== null;

const numbersOf = (test: Horoscope): number[] =>
  [test.base.infoGain, test.trained.infoGain, test.difference?.value, test.difference?.ciLow, test.difference?.ciHigh].filter(
    (v): v is number => typeof v === "number",
  );

const numbersFooter = (difference: Difference | null): string => {
  if (difference === null) return HOROSCOPE_COPY.plainFooter;
  if (difference.ciLow > 0) return HOROSCOPE_COPY.gainFooter;
  if (difference.ciHigh < 0) return HOROSCOPE_COPY.lossFooter;
  return HOROSCOPE_COPY.noGainFooter;
};

type Context = { test: Horoscope; decimals: number; chart: BarChart | null; chartSides: Side[] };

const sharedChart = (test: Horoscope, width: number): { chart: BarChart | null; sides: Side[] } => {
  const sides = SIDES.filter((side) => test[side].infoGain !== null);
  if (sides.length === 0) return { chart: null, sides };
  return { chart: barGeometry(sides.map((side) => test[side].infoGain ?? 0), width), sides };
};

const barFor = (ctx: Context, side: Side, t: number, growAt: number, height: number): string => {
  const index = ctx.chartSides.indexOf(side);
  const bar = ctx.chart?.bars[index];
  if (!ctx.chart || !bar) return "";
  const grown = easeOut(progress(t, growAt, BAR_GROW));
  const end = lerp(bar.from, bar.to, grown);
  const left = Math.min(bar.from, end);
  const width = Math.abs(end - bar.from);
  const colour = side === "trained" ? "var(--nailed)" : "var(--soft)";
  const trackWidth = (ctx.chart.domain[1] - ctx.chart.domain[0]) * ctx.chart.unitWidth;
  return `<div class="gain-track" data-bar="${side}" data-negative="${bar.value < 0}" data-width="${width.toFixed(2)}" data-scale="${ctx.chart.unitWidth.toFixed(4)}" style="width:${trackWidth.toFixed(0)}px;height:${height}px">
      <div class="gain-fill" style="left:${left.toFixed(1)}px;width:${width.toFixed(1)}px;background:${colour}"></div>
      <div class="gain-zero" data-zero-line="true" style="left:${(ctx.chart.zeroX - 1.5).toFixed(1)}px"></div>
    </div>`;
};

const valueLabel = (ctx: Context, side: Side, t: number, at: number): string => {
  const value = ctx.test[side].infoGain;
  if (value === null || t < at) return "";
  return `<span class="gain-value" style="${fadeStyle(t, at)}">${escapeHtml(`${formatValue(value, ctx.decimals)} ${ctx.test.unit}`)}</span>`;
};

const axisLabels = (chart: BarChart, unit: string): string => {
  const [low, high] = chart.domain;
  const labels = [low, 0, high].filter((v, i, all) => all.indexOf(v) === i);
  return `<div class="axis-labels" style="width:${((high - low) * chart.unitWidth).toFixed(0)}px">${labels
    .map((v) => `<span style="left:${((v - low) * chart.unitWidth).toFixed(1)}px">${escapeHtml(v === high ? `${v} ${unit}` : `${v}`)}</span>`)
    .join("")}</div>`;
};

const INTERVAL_WIDTH = 1400;

const intervalBlock = (ctx: Context, t: number, at: number): string => {
  const d = ctx.test.difference;
  if (d === null) return "";
  const g = intervalGeometry(d, INTERVAL_WIDTH);
  const grown = easeOut(progress(t, at + 0.3, INTERVAL_GROW));
  const lowX = lerp(g.valueX, g.lowX, grown);
  const highX = lerp(g.valueX, g.highX, grown);
  const f = (v: number): string => formatSigned(v, ctx.decimals);
  const labels = grown >= 1
    ? `<text x="${g.lowX.toFixed(1)}" y="118" text-anchor="middle">${f(d.ciLow)}</text><text x="${g.highX.toFixed(1)}" y="118" text-anchor="middle">${f(d.ciHigh)}</text><text x="${g.valueX.toFixed(1)}" y="28" text-anchor="${g.valueX - g.zeroX < 80 ? "start" : "middle"}" class="point-label">${f(d.value)}</text>`
    : "";
  const words = HOROSCOPE_COPY.intervalWords(f(d.value), f(d.ciLow), f(d.ciHigh), ctx.test.unit);
  return `<section class="interval" data-interval="true" style="${fadeStyle(t, at)}">
      <p class="gain-caption machine soft">${HOROSCOPE_COPY.intervalLabel}</p>
      <svg width="${INTERVAL_WIDTH}" height="130" viewBox="0 0 ${INTERVAL_WIDTH} 130" class="interval-svg">
        <line x1="0" y1="66" x2="${INTERVAL_WIDTH}" y2="66" stroke="var(--soft)" stroke-opacity="0.5" stroke-width="2"/>
        <line data-zero-line="true" x1="${g.zeroX.toFixed(1)}" y1="36" x2="${g.zeroX.toFixed(1)}" y2="96" stroke="var(--slip)" stroke-width="4"/>
        <text x="${(g.zeroX - 10).toFixed(1)}" y="28" text-anchor="end" class="zero-label">0</text>
        <line x1="${lowX.toFixed(1)}" y1="66" x2="${highX.toFixed(1)}" y2="66" stroke="var(--nailed)" stroke-width="12" stroke-linecap="round"/>
        <circle cx="${g.valueX.toFixed(1)}" cy="66" r="14" fill="var(--slip)" stroke="var(--nailed)" stroke-width="5"/>
        ${labels}
      </svg>
      <p class="interval-words" style="${fadeStyle(t, at + 0.3 + INTERVAL_GROW)}">${escapeHtml(words)}</p>
    </section>`;
};

const notes = (test: Horoscope, subtitle: string): string => {
  const extra = [test.evidenceNote, test.sampleNote].filter((n): n is string => n !== null);
  return `<p class="soft" style="font-size:30px;margin:10px 0 0">${escapeHtml(subtitle)}${extra
    .map((n) => ` <span class="machine note">${escapeHtml(n)}</span>`)
    .join("")}</p>`;
};

const caveatLine = (test: Horoscope, t: number): string =>
  test.caveat === null
    ? ""
    : `<p class="caveat" data-caveat="true" style="font-size:34px;${fadeStyle(t, 0)}">${escapeHtml(test.caveat)}</p>`;

const footerLine = (text: string, t: number, at: number): string =>
  t >= at ? `<p class="wide footer-line" style="${fadeStyle(t, at)}">${escapeHtml(text)}</p>` : "";

const COLUMN_BAR_WIDTH = 760;

const readsScene = (ctx: Context): Scene => {
  const { test } = ctx;
  const reads = SIDES.map((side) => test[side].read ?? "");
  const longest = Math.max(...reads.map((r) => typingDuration(r, CPS)));
  const barsAt = TYPE_AT + longest + 0.8;
  const valuesAt = barsAt + BAR_GROW + 0.1;
  const intervalAt = valuesAt + (test.difference ? 0.6 : 0);
  const footerAt = intervalAt + (test.difference ? 0.3 + INTERVAL_GROW + 1.2 : 1.1);
  const duration = Math.max(12, footerAt + 2.4);
  const compact = test.difference !== null || test.caveat !== null;

  const column = (side: Side, t: number): string => {
    const read = test[side].read ?? "";
    const typing = t < TYPE_AT + typingDuration(read, CPS) + 0.5;
    const bar =
      test[side].infoGain === null
        ? ""
        : `<div class="gain" style="${fadeStyle(t, barsAt - 0.3)}"><p class="gain-caption machine soft">${HOROSCOPE_COPY.barLabel}</p>${barFor(ctx, side, t, barsAt, 30)}${valueLabel(ctx, side, t, valuesAt)}</div>`;
    return `<section class="reader-column">
        <h2 class="wide reader-label" style="${fadeStyle(t, 0.5)}">${escapeHtml(test[side].label)}</h2>
        ${slip(typed(read, t, TYPE_AT, CPS), { textSize: compact ? 30 : 36, caret: typing && caretOn(t), style: `min-height:${compact ? 170 : 230}px;${feedStyle(feedAt(t, 0.7))}` })}
        ${bar}
      </section>`;
  };

  return {
    beat: 4,
    name: "horoscope-test",
    duration,
    stillAt: duration - 0.4,
    render: (t) => `<div class="horoscope">
      <header style="${fadeStyle(t, 0)}">
        <h1 class="wide headline" style="font-size:72px;margin:0">${HOROSCOPE_COPY.title}</h1>
        ${notes(test, HOROSCOPE_COPY.subtitle)}
      </header>
      ${caveatLine(test, t)}
      <div class="reader-columns" style="margin-top:${compact ? 30 : 56}px">${column("base", t)}${column("trained", t)}</div>
      ${intervalBlock(ctx, t, intervalAt)}
      ${footerLine(HOROSCOPE_COPY.readsFooter, t, footerAt)}
    </div>`,
  };
};

const NUMBERS_BAR_WIDTH = 1000;

const numbersScene = (ctx: Context): Scene => {
  const { test } = ctx;
  const barsAt = 0.8;
  const valuesAt = barsAt + BAR_GROW + 0.1;
  const intervalAt = valuesAt + 0.6;
  const footerAt = intervalAt + (test.difference ? 0.3 + INTERVAL_GROW + 1.3 : 0.8);
  const duration = Math.max(10, footerAt + 3);

  const row = (side: Side, t: number): string =>
    test[side].infoGain === null
      ? ""
      : `<div class="number-row" style="${fadeStyle(t, 0.4)}">
          <span class="wide reader-label row-label">${escapeHtml(test[side].label)}</span>
          ${barFor(ctx, side, t, barsAt, 44)}
          ${valueLabel(ctx, side, t, valuesAt)}
        </div>`;

  return {
    beat: 4,
    name: "horoscope-test",
    duration,
    stillAt: duration - 0.4,
    render: (t) => `<div class="horoscope">
      <header style="${fadeStyle(t, 0)}">
        <h1 class="wide headline" style="font-size:72px;margin:0">${HOROSCOPE_COPY.numbersTitle}</h1>
        ${notes(test, HOROSCOPE_COPY.numbersSubtitle)}
      </header>
      ${caveatLine(test, t)}
      ${ctx.chart ? `<section class="numbers-bars"><p class="gain-caption machine soft">${HOROSCOPE_COPY.barLabel}</p>${row("base", t)}${row("trained", t)}<div class="number-row"><span class="row-label"></span>${axisLabels(ctx.chart, test.unit)}</div></section>` : ""}
      ${intervalBlock(ctx, t, intervalAt)}
      ${footerLine(numbersFooter(test.difference), t, footerAt)}
    </div>`,
  };
};

export const horoscopeScene = (test: Horoscope): Scene => {
  const withReads = hasBothReads(test);
  const { chart, sides } = sharedChart(test, withReads ? COLUMN_BAR_WIDTH : NUMBERS_BAR_WIDTH);
  const ctx: Context = { test, decimals: shownDecimals(numbersOf(test)), chart, chartSides: sides };
  return withReads ? readsScene(ctx) : numbersScene(ctx);
};
