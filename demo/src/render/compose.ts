import { join } from "node:path";
import { appClipArgs, concatArgs, stillArgs, type VideoLayer } from "../ffmpeg/args";
import { probeDuration, runFfmpeg } from "../ffmpeg/run";
import { log } from "../log";
import { BEAT_NAMES, beatLabel, type BeatId } from "../plan/beats";
import {
  CHAIN_MAX_UPSCALE,
  CHAIN_TARGET,
  FPS,
  FRAME,
  FULL_FRAME,
  PLAY_LAYOUT,
  cropForChain,
  fitInto,
} from "../plan/layout";
import { appWindows } from "../plan/windows";
import type { Markers } from "../record/markers";
import { MOCK_PLAY_STAGE, chainBackground, joinOverlay, phoneMask, playBackground } from "../scenes/appStills";
import type { Scene } from "../scenes/scene";
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
  return encodeApp(2, ctx, { duration: window.duration, background, overlay, layers }, window.duration - 0.5);
};

const renderPlay = async (ctx: AppContext): Promise<Clip> => {
  const windows = appWindows(ctx.markers);
  const phone = ctx.markers.phone;
  const background = await still(ctx, "beat5-background", playBackground({ mode: ctx.markers.mode, phoneNickname: phone?.nickname ?? null }), false);
  const stageBox = phone === null ? MOCK_PLAY_STAGE : PLAY_LAYOUT.stage;
  const layers: VideoLayer[] = [{ file: stageFile(ctx), start: windows.play.start, box: stageBox }];
  if (phone !== null) {
    const phoneStart = windows.playPhoneStart;
    if (phoneStart === null || phoneStart < 0) {
      throw new Error(`${beatLabel(5)}: the phone video starts after the play window (offset ${phoneStart ?? "none"}s). Check markers.json.`);
    }
    const { width, height } = PLAY_LAYOUT.phone;
    const mask = await still(ctx, "beat5-phone-mask", phoneMask(), false, { x: 0, y: 0, width, height });
    layers.push({ file: join(ctx.rawDir, phone.file), start: phoneStart, box: PLAY_LAYOUT.phone, mask });
  }
  const heroAt = Math.min(
    windows.play.duration - 0.5,
    (ctx.markers.revealAt + 2_500 - ctx.markers.stage.startedAt) / 1000 - windows.play.start,
  );
  return encodeApp(5, ctx, { duration: windows.play.duration, background, overlay: null, layers }, heroAt);
};

const renderChain = async (ctx: AppContext): Promise<Clip> => {
  const box = ctx.markers.chainBox;
  if (box === null) throw new Error(`${beatLabel(6)}: markers.json has no chainBox, so there is nothing to crop.`);
  const window = appWindows(ctx.markers).chain;
  const crop = cropForChain(box, FRAME, CHAIN_TARGET, CHAIN_MAX_UPSCALE);
  const target = fitInto(crop, CHAIN_TARGET);
  const background = await still(ctx, "beat6-background", chainBackground(ctx.markers.mode), false);
  const layers: VideoLayer[] = [{ file: stageFile(ctx), start: window.start, box: target, crop }];
  return encodeApp(6, ctx, { duration: window.duration, background, overlay: null, layers }, window.duration - 0.5);
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

export const assembleFilm = async (clips: readonly Clip[], framesDir: string, filmPath: string): Promise<FilmResult> => {
  const durations: Array<{ beat: BeatId; seconds: number }> = [];
  for (const clip of clips) {
    const seconds = await probeDuration(clip.path, `${beatLabel(clip.beat)}: probing the clip`);
    durations.push({ beat: clip.beat, seconds });
    const frame = join(framesDir, `beat${clip.beat}-${BEAT_NAMES[clip.beat]}.png`);
    const at = Math.max(0, Math.min(clip.stillAt, seconds - 0.1));
    await runFfmpeg(stillArgs({ clip: clip.path, at, out: frame }), `${beatLabel(clip.beat)}: extracting the review still`);
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
