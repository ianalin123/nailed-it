import type { Rect } from "../plan/layout";

const COMMON = ["-y", "-hide_banner", "-loglevel", "error"] as const;

const encodeH264 = (fps: number): string[] => [
  "-r",
  String(fps),
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-color_range",
  "tv",
  "-an",
  "-movflags",
  "+faststart",
];

const sec = (value: number): string => value.toFixed(3);

export type SceneEncodeSpec = { out: string; fps: number; frames: number };

export const sceneEncodeArgs = ({ out, fps, frames }: SceneEncodeSpec): string[] => [
  ...COMMON,
  "-f",
  "image2pipe",
  "-framerate",
  String(fps),
  "-i",
  "-",
  "-frames:v",
  String(frames),
  "-vf",
  "scale=out_range=tv,format=yuv420p",
  ...encodeH264(fps),
  out,
];

export type VideoLayer = {
  file: string;
  start: number;
  box: Rect;
  crop?: Rect;
  mask?: string;
};

export type AppClipSpec = {
  out: string;
  duration: number;
  fps: number;
  background: string;
  overlay: string | null;
  layers: readonly VideoLayer[];
};

type Graph = { inputs: string[]; filters: string[]; next: number };

const stillInput = (path: string, fps: number, duration: number): string[] => [
  "-loop",
  "1",
  "-framerate",
  String(fps),
  "-t",
  sec(duration),
  "-i",
  path,
];

const addInput = (graph: Graph, input: string[]): number => {
  graph.inputs.push(...input);
  const index = graph.next;
  graph.next += 1;
  return index;
};

const normalize = (index: number, fps: number): string => `[${index}:v]fps=${fps},setpts=PTS-STARTPTS`;

const layerFilter = (graph: Graph, layer: VideoLayer, i: number, spec: AppClipSpec): string => {
  const video = addInput(graph, ["-ss", sec(layer.start), "-t", sec(spec.duration), "-i", layer.file]);
  const crop = layer.crop ? `,crop=${layer.crop.width}:${layer.crop.height}:${layer.crop.x}:${layer.crop.y}` : "";
  const scaled = `layer${i}`;
  graph.filters.push(
    `${normalize(video, spec.fps)}${crop},scale=${layer.box.width}:${layer.box.height}:flags=lanczos,format=rgba[${scaled}]`,
  );
  if (!layer.mask) return scaled;
  const mask = addInput(graph, stillInput(layer.mask, spec.fps, spec.duration));
  graph.filters.push(`${normalize(mask, spec.fps)},scale=${layer.box.width}:${layer.box.height},format=gray[mask${i}]`);
  graph.filters.push(`[${scaled}][mask${i}]alphamerge[masked${i}]`);
  return `masked${i}`;
};

export const appClipArgs = (spec: AppClipSpec): string[] => {
  const graph: Graph = { inputs: [], filters: [], next: 0 };
  const background = addInput(graph, stillInput(spec.background, spec.fps, spec.duration));
  graph.filters.push(`${normalize(background, spec.fps)},format=rgba[base0]`);
  let base = "base0";
  spec.layers.forEach((layer, i) => {
    const label = layerFilter(graph, layer, i, spec);
    const next = `base${i + 1}`;
    graph.filters.push(`[${base}][${label}]overlay=${layer.box.x}:${layer.box.y}:eof_action=repeat[${next}]`);
    base = next;
  });
  if (spec.overlay !== null) {
    const overlay = addInput(graph, stillInput(spec.overlay, spec.fps, spec.duration));
    graph.filters.push(`${normalize(overlay, spec.fps)},format=rgba[over]`);
    graph.filters.push(`[${base}][over]overlay=0:0[top]`);
    base = "top";
  }
  graph.filters.push(`[${base}]format=yuv420p[out]`);
  return [
    ...COMMON,
    ...graph.inputs,
    "-filter_complex",
    graph.filters.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    String(Math.round(spec.duration * spec.fps)),
    ...encodeH264(spec.fps),
    spec.out,
  ];
};

export const xfadeOffsets = (durations: readonly number[], fade: number): number[] => {
  durations.forEach((duration, i) => {
    if (duration <= 2 * fade) throw new Error(`clip ${i + 1} is ${duration}s, too short for a ${fade}s crossfade`);
  });
  const offsets: number[] = [];
  let running = 0;
  for (let k = 1; k < durations.length; k += 1) {
    running += durations[k - 1] ?? 0;
    offsets.push(Number((running - k * fade).toFixed(6)));
  }
  return offsets;
};

export type ConcatSpec = { clips: ReadonlyArray<{ path: string; duration: number }>; fade: number; out: string; fps: number };

export const concatArgs = ({ clips, fade, out, fps }: ConcatSpec): string[] => {
  if (clips.length === 0) throw new Error("No clips to join into the film");
  const inputs = clips.flatMap((clip) => ["-i", clip.path]);
  if (clips.length === 1) return [...COMMON, ...inputs, ...encodeH264(fps), out];
  const offsets = xfadeOffsets(
    clips.map((clip) => clip.duration),
    fade,
  );
  const filters = clips.map((_, i) => `${normalize(i, fps)},scale=out_range=tv,settb=AVTB,format=yuv420p[c${i}]`);
  let previous = "c0";
  offsets.forEach((offset, k) => {
    const label = `x${k + 1}`;
    filters.push(`[${previous}][c${k + 1}]xfade=transition=fade:duration=${sec(fade)}:offset=${sec(offset)}[${label}]`);
    previous = label;
  });
  filters.push(`[${previous}]format=yuv420p[out]`);
  return [...COMMON, ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", ...encodeH264(fps), out];
};

export type StillSpec = { clip: string; at: number; out: string };

export const stillArgs = ({ clip, at, out }: StillSpec): string[] => [...COMMON, "-ss", sec(at), "-i", clip, "-frames:v", "1", out];
