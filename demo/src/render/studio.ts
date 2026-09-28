import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { sceneEncodeArgs } from "../ffmpeg/args";
import { openFramePipe } from "../ffmpeg/run";
import { beatLabel } from "../plan/beats";
import { FPS, FRAME, type Rect } from "../plan/layout";
import { shellHtml } from "../scenes/shell";
import type { Scene } from "../scenes/scene";
import { frameCount, frameTime } from "../timeline/timeline";
import { log } from "../log";

export type Studio = { page: Page; close: () => Promise<void> };

const REQUIRED_FONTS = ['400 40px "Courier Prime"', '700 40px "Courier Prime"', '900 40px "Archivo Variable"'] as const;

const assertFontsLoaded = async (page: Page): Promise<void> => {
  const counts = await page.evaluate(async (fonts) => {
    const loaded = await Promise.all(fonts.map((font) => document.fonts.load(font)));
    return loaded.map((faces) => faces.length);
  }, [...REQUIRED_FONTS]);
  const missing = REQUIRED_FONTS.filter((_, i) => (counts[i] ?? 0) === 0);
  if (missing.length > 0) {
    throw new Error(`Scene fonts failed to load in the browser: ${missing.join(", ")}. Check the @fontsource packages in demo/node_modules.`);
  }
};

export const openStudio = async (browser: Browser, workDir: string): Promise<Studio> => {
  const shellPath = join(workDir, "shell.html");
  writeFileSync(shellPath, shellHtml());
  const context: BrowserContext = await browser.newContext({ viewport: FRAME, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(shellPath).href, { waitUntil: "load" });
  await assertFontsLoaded(page);
  if (errors.length > 0) throw new Error(`The scene shell page threw: ${errors.join("; ")}`);
  return { page, close: () => context.close() };
};

const setRoot = async (page: Page, html: string, transparent: boolean): Promise<void> => {
  await page.evaluate(
    ([markup, bodyClass]) => {
      const root = document.getElementById("root");
      if (!root) throw new Error("Scene shell has no #root element");
      document.body.className = bodyClass;
      root.innerHTML = markup;
    },
    [html, transparent ? "transparent" : "opaque"] as const,
  );
};

export const renderSceneClip = async (studio: Studio, scene: Scene, out: string): Promise<void> => {
  const frames = frameCount(scene.duration, FPS);
  const label = `${beatLabel(scene.beat)}: encoding ${frames} frames`;
  const pipe = openFramePipe(sceneEncodeArgs({ out, fps: FPS, frames }), label);
  for (let frame = 0; frame < frames; frame += 1) {
    await setRoot(studio.page, scene.render(frameTime(frame, FPS)), false);
    await pipe.write(await studio.page.screenshot({ type: "jpeg", quality: 94 }));
    if (frame > 0 && frame % 90 === 0) log(`  ${beatLabel(scene.beat)}: frame ${frame} of ${frames}`);
  }
  await pipe.end();
};

export type StillOptions = { transparent: boolean; clip?: Rect };

export const renderStill = async (studio: Studio, html: string, out: string, options: StillOptions): Promise<void> => {
  await setRoot(studio.page, html, options.transparent);
  await studio.page.screenshot({
    path: out,
    type: "png",
    omitBackground: options.transparent,
    ...(options.clip ? { clip: options.clip } : {}),
  });
};
