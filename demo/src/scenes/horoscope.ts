import type { Results } from "../data/results";
import { fadeStyle, feedAt, feedStyle } from "../timeline/motion";
import { easeOut, progress, typed, typingDuration } from "../timeline/timeline";
import { caretOn, slip } from "./parts";
import { escapeHtml, type Scene } from "./scene";

type Horoscope = NonNullable<Results["horoscopeTest"]>;
type Side = "base" | "trained";

export const HOROSCOPE_COPY = {
  title: "The horoscope test",
  subtitle: "Same evidence. Two readers.",
  barLabel: "Information gain over the base rate",
  footer: "A read that fits everyone earns nothing.",
} as const;

const TYPE_AT = 1.1;
const CPS = 36;
const BAR_WIDTH = 760;
const ZERO_AT = 0.2;

export const formatGain = (value: number, unit: Horoscope["unit"]): string => `${value.toFixed(2)} ${unit}`;

const barScale = (test: Horoscope): number => {
  const values = [test.base.infoGain, test.trained.infoGain].filter((v): v is number => v !== null);
  const positive = Math.max(0, ...values);
  const negative = Math.max(0, ...values.map((v) => -v));
  const scale = Math.max(positive / (1 - ZERO_AT), negative / ZERO_AT);
  return scale > 0 ? scale : 1;
};

export const horoscopeScene = (test: Horoscope): Scene => {
  const longest = Math.max(typingDuration(test.base.read, CPS), typingDuration(test.trained.read, CPS));
  const barsAt = TYPE_AT + longest + 0.8;
  const valuesAt = barsAt + 1.2;
  const footerAt = valuesAt + 1.1;
  const duration = Math.max(12, footerAt + 2.4);
  const scale = barScale(test);

  const bar = (side: Side, t: number): string => {
    const value = test[side].infoGain;
    if (value === null) return "";
    const grown = easeOut(progress(t, barsAt, 1.1));
    const width = (Math.abs(value) / scale) * BAR_WIDTH * grown;
    const zeroX = ZERO_AT * BAR_WIDTH;
    const left = value >= 0 ? zeroX : zeroX - width;
    const colour = side === "trained" ? "var(--nailed)" : "var(--soft)";
    const label =
      t >= valuesAt
        ? `<span class="gain-value" style="${fadeStyle(t, valuesAt)}">${escapeHtml(formatGain(value, test.unit))}</span>`
        : "";
    return `<div class="gain" data-bar="${side}" data-negative="${value < 0}" style="${fadeStyle(t, barsAt - 0.3)}">
        <p class="gain-caption machine soft">${HOROSCOPE_COPY.barLabel}</p>
        <div class="gain-track" style="width:${BAR_WIDTH}px"><div class="gain-zero" style="left:${zeroX}px"></div>
          <div class="gain-fill" style="left:${left.toFixed(1)}px;width:${width.toFixed(1)}px;background:${colour}"></div></div>
        ${label}
      </div>`;
  };

  const column = (side: Side, t: number): string => {
    const reader = test[side];
    const text = typed(reader.read, t, TYPE_AT, CPS);
    const typing = t < TYPE_AT + typingDuration(reader.read, CPS) + 0.5;
    return `<section class="reader-column">
        <h2 class="wide reader-label" style="${fadeStyle(t, 0.5)}">${escapeHtml(reader.label)}</h2>
        ${slip(text, { textSize: 36, caret: typing && caretOn(t), style: `min-height:230px;${feedStyle(feedAt(t, 0.7))}` })}
        ${bar(side, t)}
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
        <p class="soft" style="font-size:32px;margin:10px 0 0">${HOROSCOPE_COPY.subtitle}${
          test.evidenceNote ? ` <span class="machine">${escapeHtml(test.evidenceNote)}</span>` : ""
        }</p>
      </header>
      <div class="reader-columns">${column("base", t)}${column("trained", t)}</div>
      ${t >= footerAt ? `<p class="wide footer-line" style="${fadeStyle(t, footerAt)}">${HOROSCOPE_COPY.footer}</p>` : ""}
    </div>`,
  };
};
