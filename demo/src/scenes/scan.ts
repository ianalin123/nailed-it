import { deadEnds, type Scan } from "../data/scan";
import { fadeStyle, feedAt, feedStyle } from "../timeline/motion";
import { easeOut, lerp, progress, typed } from "../timeline/timeline";
import { slip, tag } from "./parts";
import { escapeHtml, type Scene } from "./scene";

export const SCAN_COPY = {
  replay: "Replay",
  title: (subject: string) => `Reading ${subject}`,
  looking: (source: string) => `Looking at ${source}: `,
  footer: "Every read points back to what it saw.",
} as const;

type Point = { x: number; y: number };

const CLUSTER_RADIUS = 100;
const E_START = 1.4;
const E_SPAN = 5.0;
const INFERENCE_STEP = 0.6;
const READ_STEP = 0.7;
const LINE_DRAW = 0.45;

const spread = (count: number, index: number, from: number, to: number): number =>
  count <= 1 ? (from + to) / 2 : from + (index * (to - from)) / (count - 1);

const clusterCentre = (count: number, index: number): Point => ({
  x: index % 2 === 0 ? 300 : 650,
  y: spread(count, index, 360, 880),
});

const dotOffset = (k: number, sourceIndex: number): Point => {
  const angle = k * 2.39996 + sourceIndex * 0.9;
  const radius = 28 + ((k * 23) % 54);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
};

const nodeY = (count: number, index: number): number => spread(count, index, 330, 830);

const curve = (a: Point, b: Point): { d: string; length: number } => {
  const dx = (b.x - a.x) * 0.5;
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  const at = (s: number): Point => ({
    x: (1 - s) ** 3 * a.x + 3 * (1 - s) ** 2 * s * c1.x + 3 * (1 - s) * s ** 2 * c2.x + s ** 3 * b.x,
    y: (1 - s) ** 3 * a.y + 3 * (1 - s) ** 2 * s * c1.y + 3 * (1 - s) * s ** 2 * c2.y + s ** 3 * b.y,
  });
  let length = 0;
  let previous = a;
  for (let i = 1; i <= 24; i += 1) {
    const next = at(i / 24);
    length += Math.hypot(next.x - previous.x, next.y - previous.y);
    previous = next;
  }
  const f = (n: number): string => n.toFixed(1);
  return { d: `M${f(a.x)} ${f(a.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`, length };
};

const line = (a: Point, b: Point, t: number, start: number, colour: string): string => {
  if (t < start) return "";
  const { d, length } = curve(a, b);
  const drawn = easeOut(progress(t, start, LINE_DRAW));
  return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length * (1 - drawn)).toFixed(1)}"/>`;
};

type Layout = {
  dots: Map<string, Point>;
  evidenceAt: Map<string, number>;
  inferenceAt: Map<string, number>;
  readAt: Map<string, number>;
  inferencePoint: Map<string, Point>;
  readPoint: Map<string, Point>;
  deadAt: number;
  footerAt: number;
  duration: number;
};

const layoutScan = (scan: Scan): Layout => {
  const sourceIndex = new Map(scan.sources.map((s, i) => [s.id, i]));
  const perSource = new Map<string, number>();
  const dots = new Map<string, Point>();
  const evidenceAt = new Map<string, number>();
  scan.evidence.forEach((e, j) => {
    const index = sourceIndex.get(e.source) ?? 0;
    const k = perSource.get(e.source) ?? 0;
    perSource.set(e.source, k + 1);
    const centre = clusterCentre(scan.sources.length, index);
    const offset = dotOffset(k, index);
    dots.set(e.id, { x: centre.x + offset.x, y: centre.y + offset.y });
    evidenceAt.set(e.id, E_START + (j * E_SPAN) / scan.evidence.length);
  });
  const inferenceStart = E_START + E_SPAN;
  const inferenceAt = new Map(scan.inferences.map((inf, i) => [inf.id, inferenceStart + i * INFERENCE_STEP]));
  const inferencePoint = new Map(scan.inferences.map((inf, i) => [inf.id, { x: 940, y: nodeY(scan.inferences.length, i) }]));
  const readStart = inferenceStart + scan.inferences.length * INFERENCE_STEP + 0.3;
  const readAt = new Map(scan.reads.map((r, i) => [r.id, readStart + i * READ_STEP]));
  const readPoint = new Map(scan.reads.map((r, i) => [r.id, { x: 1300, y: nodeY(scan.reads.length, i) }]));
  const footerAt = readStart + scan.reads.length * READ_STEP + 0.6;
  return {
    dots,
    evidenceAt,
    inferenceAt,
    readAt,
    inferencePoint,
    readPoint,
    deadAt: readStart,
    footerAt,
    duration: Math.max(12, footerAt + 1.6),
  };
};

const INFERENCE_WIDTH = 300;
const PINK = "#ff3d7f";
const SOFT = "#c9d0ff";

export const scanScene = (scan: Scan): Scene => {
  const layout = layoutScan(scan);
  const dead = new Set(deadEnds(scan));
  const usedAt = new Map<string, number>();
  const markUse = (id: string, at: number): void => {
    const known = usedAt.get(id);
    if (known === undefined || at < known) usedAt.set(id, at);
  };
  scan.inferences.forEach((inf) => inf.from.forEach((id) => markUse(id, layout.inferenceAt.get(inf.id) ?? 0)));
  scan.reads.forEach((read) => read.from.forEach((id) => markUse(id, layout.readAt.get(read.id) ?? 0)));
  const sourceLabel = new Map(scan.sources.map((s) => [s.id, s.label]));
  const at = <K>(map: Map<K, number>, key: K): number => map.get(key) ?? Number.POSITIVE_INFINITY;
  const pointOf = (id: string): Point =>
    layout.dots.get(id) ?? layout.inferencePoint.get(id) ?? { x: 0, y: 0 };
  const exitOf = (id: string): Point => {
    const inference = layout.inferencePoint.get(id);
    return inference ? { x: inference.x + INFERENCE_WIDTH, y: inference.y } : pointOf(id);
  };

  const clusters = (t: number): string =>
    scan.sources
      .map((_, i) => {
        const c = clusterCentre(scan.sources.length, i);
        const p = easeOut(progress(t, 0.4 + i * 0.18, 0.5));
        return `<circle cx="${c.x}" cy="${c.y}" r="${(CLUSTER_RADIUS * lerp(0.6, 1, p)).toFixed(1)}" fill="rgba(29,43,171,0.55)" stroke="${SOFT}" stroke-opacity="${(0.5 * p).toFixed(3)}" stroke-width="2" stroke-dasharray="6 8" opacity="${p.toFixed(3)}"/>`;
      })
      .join("");

  const clusterLabels = (t: number): string =>
    scan.sources
      .map((source, i) => {
        const c = clusterCentre(scan.sources.length, i);
        return `<div class="cluster-label" style="left:${c.x - 150}px;top:${c.y - CLUSTER_RADIUS - 44}px;${fadeStyle(t, 0.5 + i * 0.18)}">${escapeHtml(source.label)}</div>`;
      })
      .join("");

  const dots = (t: number): string =>
    scan.evidence
      .map((e) => {
        const p = easeOut(progress(t, at(layout.evidenceAt, e.id), 0.3));
        const point = layout.dots.get(e.id) ?? { x: 0, y: 0 };
        const isDead = dead.has(e.id);
        const fade = isDead ? lerp(1, 0.22, progress(t, layout.deadAt, 0.6)) : 1;
        const fill = t >= at(usedAt, e.id) ? PINK : "#f2f4f3";
        return `<circle data-id="${e.id}" data-dead="${isDead}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${(10 * p).toFixed(2)}" fill="${fill}" opacity="${(p * fade).toFixed(3)}"/>`;
      })
      .join("");

  const lines = (t: number): string => {
    const toInferences = scan.inferences.flatMap((inf) => {
      const target = layout.inferencePoint.get(inf.id) ?? { x: 0, y: 0 };
      return inf.from.map((id) => line(pointOf(id), target, t, at(layout.inferenceAt, inf.id), SOFT));
    });
    const toReads = scan.reads.flatMap((read) => {
      const target = layout.readPoint.get(read.id) ?? { x: 0, y: 0 };
      return read.from.map((id) => line(exitOf(id), target, t, at(layout.readAt, read.id), PINK));
    });
    return [...toInferences, ...toReads].join("");
  };

  const inferences = (t: number): string =>
    scan.inferences
      .map((inf) => {
        const start = at(layout.inferenceAt, inf.id) + LINE_DRAW - 0.1;
        if (t < start) return "";
        const point = layout.inferencePoint.get(inf.id) ?? { x: 0, y: 0 };
        return `<div class="anchor" style="left:${point.x}px;top:${point.y}px;width:${INFERENCE_WIDTH}px"><div class="inference" style="${fadeStyle(t, start)}">${escapeHtml(inf.text)}</div></div>`;
      })
      .join("");

  const reads = (t: number): string =>
    scan.reads
      .map((read) => {
        const start = at(layout.readAt, read.id) + LINE_DRAW - 0.15;
        if (t < start) return "";
        const point = layout.readPoint.get(read.id) ?? { x: 0, y: 0 };
        const card = slip(typed(read.text, t, start + 0.1, 90), {
          textSize: 25,
          style: `width:560px;padding:18px 24px calc(14px + 14px);${feedStyle(feedAt(t, start))}`,
        });
        return `<div class="anchor" style="left:${point.x}px;top:${point.y}px">${card}</div>`;
      })
      .join("");

  const ticker = (t: number): string => {
    const current = [...scan.evidence].reverse().find((e) => at(layout.evidenceAt, e.id) <= t);
    if (!current || t > layout.deadAt) return "";
    const start = at(layout.evidenceAt, current.id);
    const prefix = SCAN_COPY.looking(sourceLabel.get(current.source) ?? current.source);
    return `<p class="ticker">${escapeHtml(prefix)}${escapeHtml(typed(current.text, t, start, 70))}</p>`;
  };

  const header = (t: number): string => `<header class="scan-header" style="${fadeStyle(t, 0)}">
      ${tag(SCAN_COPY.replay, "font-size:24px;border-color:#ff3d7f;color:#ff3d7f")}
      <h1 class="wide headline" style="font-size:60px;margin:14px 0 6px">${escapeHtml(SCAN_COPY.title(scan.subject))}</h1>
      ${scan.note ? `<p class="machine soft" style="font-size:24px;margin:0">${escapeHtml(scan.note)}</p>` : ""}
    </header>`;

  const footer = (t: number): string =>
    t >= layout.footerAt
      ? `<p class="wide footer-line" style="${fadeStyle(t, layout.footerAt)}">${SCAN_COPY.footer}</p>`
      : "";

  return {
    beat: 3,
    name: "scan",
    duration: layout.duration,
    stillAt: layout.duration - 0.4,
    render: (t) => `<svg class="scan-svg" viewBox="0 0 1920 1080" width="1920" height="1080">${clusters(t)}${lines(t)}${dots(t)}</svg>
      ${header(t)}${clusterLabels(t)}${inferences(t)}${reads(t)}${ticker(t)}${footer(t)}`,
  };
};
