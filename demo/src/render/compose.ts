import { join } from "node:path";
import { appClipArgs, concatArgs, contactSheetArgs, regionProbeArgs, stillArgs, type VideoLayer } from "../ffmpeg/args";
import { probeDuration, probeVideoSize, runFfmpeg, runFfmpegBinary, runFfmpegToFile } from "../ffmpeg/run";
import { log, warn } from "../log";
import { BEAT_NAMES, beatLabel, type BeatId } from "../plan/beats";
import { FPS, FRAME, FULL_FRAME, PHONE_VIEWPORT, PLAY_LAYOUT, SPOTLIGHT_PADDING, phoneCrop, spotlight } from "../plan/layout";
import { appWindows, revealFraction } from "../plan/windows";
import type { Markers } from "../record/markers";
import { MOCK_PLAY_STAGE, chainOverlay, joinOverlay, phoneMask, playBackground, playCaption } from "../scenes/appStills";
import type { Scene } from "../scenes/scene";
import { flatGrayFraction } from "./checks";
import { renderSceneClip, renderStill, type Studio } from "./studio";

export type Clip = { beat: BeatId; path: string; stillAt: number };

export const clipPath = (dir: string, beat: BeatId): string => join(dir, `beat${beat}-${BEAT_NAMES[beat]}.mp4`);

export const renderScene = async (studio: Studio, scene: Scene, clipsDir: string): Promise<Clip> => {
  const path = clipPath(clipsDir, scene.beat);
  log(`${beatLabel(scene.beat)}: rendering ${scene.duration.toFixed(1)}s of frames`);
  await renderSceneClip(studio, scene, path);
  return { beat: scene.beat, path, stillAt: scene.stillAt };
};

type AppContext = { studio: Studio; markers: Markers; rawDir: string; clipsDir: string; workDir: string };

const still = async (ctx: AppContext, name: string, html: string, transparent: boolean, clip?: { x: number; y: number; width: number; height: number }): Promise<string> => {
  const path = join(ctx.workDir, `${name}.png`);
  await renderStill(ctx.studio, html, path, clip ? { transparent, clip } : { transparent });
  return path;
};

const encodeApp = async (beat: BeatId, ctx: AppContext, spec: Omit<Parameters<typeof appClipArgs>[0], "out" | "fps">, stillAt: number): Promise<Clip> => {
  const path = clipPath(ctx.clipsDir, beat);
  log(`${beatLabel(beat)}: compositing ${spec.duration.toFixed(1)}s from the recording`);
  await runFfmpeg(appClipArgs({ ...spec, out: path, fps: FPS }), `${beatLabel(beat)}: compositing the recording`);
  return { beat, path, stillAt };
};

const stageFile = (ctx: AppContext): string => join(ctx.rawDir, ctx.markers.stage.file);

const renderJoin = async (ctx: AppContext): Promise<Clip> => {
  const window = appWindows(ctx.markers).join;
  const background = await still(ctx, "beat2-background", "", false);
  const overlay = await still(ctx, "beat2-overlay", joinOverlay(ctx.markers.mode), true);
  const layers: VideoLayer[] = [{ file: stageFile(ctx), start: window.start, box: FULL_FRAME }];
  return encodeApp(2, ctx, { duration: window.duration, background, overlays: [{ path: overlay }], layers }, window.duration - 0.5);
};

const MAX_PHONE_GRAY = 0.1;
const PROBE_SIZE = { width: 42, height: 91 } as const;

const assertPhoneFilled = async (clip: string, duration: number): Promise<void> => {
  for (const fraction of [0.25, 0.5, 0.75]) {
    const at = duration * fraction;
    const pixels = await runFfmpegBinary(
      regionProbeArgs({ clip, at, region: PLAY_LAYOUT.phone, size: PROBE_SIZE }),
      `${beatLabel(5)}: sampling the phone region`,
    );
    const gray = flatGrayFraction(pixels);
    if (gray > MAX_PHONE_GRAY) {
      throw new Error(
        `${beatLabel(5)}: ${(gray * 100).toFixed(0)}% of the phone frame is flat gray at ${at.toFixed(1)}s of ${clip}. The phone recording is padded or misaligned; check its size against the ${PHONE_VIEWPORT.width}x${PHONE_VIEWPORT.height} viewport.`,
      );
    }
  }
  log(`${beatLabel(5)}: phone region checked, no gray padding`);
};

const phoneLayer = async (ctx: AppContext, phone: NonNullable<Markers["phone"]>, start: number): Promise<VideoLayer> => {
  const file = join(ctx.rawDir, phone.file);
  const size = await probeVideoSize(file, `${beatLabel(5)}: probing the phone video`);
  const crop = phoneCrop(size, PHONE_VIEWPORT);
  if (crop) log(`${beatLabel(5)}: phone video is ${size.width}x${size.height}, cropping the ${crop.width}x${crop.height} app region`);
  const { width, height } = PLAY_LAYOUT.phone;
  const mask = await still(ctx, "beat5-phone-mask", phoneMask(), false, { x: 0, y: 0, width, height });
  return { file, start, box: PLAY_LAYOUT.phone, mask, ...(crop ? { crop } : {}) };
};

const renderPlay = async (ctx: AppContext): Promise<Clip> => {
  const windows = appWindows(ctx.markers);
  const phone = ctx.markers.phone;
  const nickname = phone?.nickname ?? null;
  const background = await still(ctx, "beat5-background", playBackground({ mode: ctx.markers.mode, phoneNickname: nickname }), false);
  const guessing = await still(ctx, "beat5-caption-guessing", playCaption("guessing", nickname), true);
  const revealed = await still(ctx, "beat5-caption-revealed", playCaption("revealed", nickname), true);
  const fraction = revealFraction(ctx.markers);
  if (fraction < 0.5 || fraction > 0.85) {
    warn(`${beatLabel(5)}: the stamp lands ${(fraction * 100).toFixed(0)}% of the way through the beat; aim for about two thirds.`);
  }
  const revealAt = fraction * windows.play.duration;
  const stageBox = phone === null ? MOCK_PLAY_STAGE : PLAY_LAYOUT.stage;
  const layers: VideoLayer[] = [{ file: stageFile(ctx), start: windows.play.start, box: stageBox }];
  if (phone !== null) {
    const phoneStart = windows.playPhoneStart;
    if (phoneStart === null || phoneStart < 0) {
      throw new Error(`${beatLabel(5)}: the phone video starts after the play window (offset ${phoneStart ?? "none"}s). Check markers.json.`);
    }
    layers.push(await phoneLayer(ctx, phone, phoneStart));
  }
  const overlays = [
    { path: guessing, until: revealAt },
    { path: revealed, from: revealAt },
  ];
  const clip = await encodeApp(5, ctx, { duration: windows.play.duration, background, overlays, layers }, revealAt + 2.5);
  if (phone !== null) await assertPhoneFilled(clip.path, windows.play.duration);
  return clip;
};

const renderChain = async (ctx: AppContext): Promise<Clip> => {
  const box = ctx.markers.chainBox;
  if (box === null) throw new Error(`${beatLabel(6)}: markers.json has no chainBox, so there is nothing to spotlight.`);
  const window = appWindows(ctx.markers).chain;
  const background = await still(ctx, "beat6-background", "", false);
  const overlay = await still(ctx, "beat6-spotlight", chainOverlay(ctx.markers.mode, spotlight(box, FRAME, SPOTLIGHT_PADDING)), true);
  const layers: VideoLayer[] = [{ file: stageFile(ctx), start: window.start, box: FULL_FRAME }];
  const overlays = [{ path: overlay, fadeIn: { start: 0.2, duration: 0.7 } }];
  return encodeApp(6, ctx, { duration: window.duration, background, overlays, layers }, window.duration - 0.5);
};

export const renderAppBeat = (beat: BeatId, ctx: AppContext): Promise<Clip> => {
  switch (beat) {
    case 2:
      return renderJoin(ctx);
    case 5:
      return renderPlay(ctx);
    case 6:
      return renderChain(ctx);
    default:
      throw new Error(`${beatLabel(beat)} is not an app beat`);
  }
};

export type FilmResult = { durations: Array<{ beat: BeatId; seconds: number }>; total: number };

const FADE_SECONDS = 0.3;

export const writeContactSheets = async (clips: readonly Clip[], durations: FilmResult["durations"], framesDir: string): Promise<void> => {
  for (const [i, clip] of clips.entries()) {
    const duration = durations[i]?.seconds;
    if (duration === undefined) throw new Error(`${beatLabel(clip.beat)}: no probed duration for the contact sheet`);
    const out = join(framesDir, `beat${clip.beat}-${BEAT_NAMES[clip.beat]}-contact.png`);
    await runFfmpegToFile(contactSheetArgs({ clip: clip.path, duration, out }), out, `${beatLabel(clip.beat)}: contact sheet`);
  }
  log(`contact sheets written to ${framesDir}`);
};

export const assembleFilm = async (clips: readonly Clip[], framesDir: string, filmPath: string): Promise<FilmResult> => {
  const durations: Array<{ beat: BeatId; seconds: number }> = [];
  for (const clip of clips) {
    const seconds = await probeDuration(clip.path, `${beatLabel(clip.beat)}: probing the clip`);
    durations.push({ beat: clip.beat, seconds });
    const frame = join(framesDir, `beat${clip.beat}-${BEAT_NAMES[clip.beat]}.png`);
    const at = Math.max(0, Math.min(clip.stillAt, seconds - 0.1));
    await runFfmpegToFile(stillArgs({ clip: clip.path, at, out: frame }), frame, `${beatLabel(clip.beat)}: extracting the review still`);
  }
  log(`joining ${clips.length} clips with ${FADE_SECONDS}s crossfades`);
  await runFfmpeg(
    concatArgs({
      clips: clips.map((clip, i) => ({ path: clip.path, duration: durations[i]?.seconds ?? 0 })),
      fade: FADE_SECONDS,
      out: filmPath,
      fps: FPS,
    }),
    "joining the clips into the film",
  );
  const total = await probeDuration(filmPath, "probing the finished film");
  return { durations, total };
};
