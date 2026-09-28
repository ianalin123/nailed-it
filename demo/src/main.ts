import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { parseArgs, type Args } from "./cli/args";
import { coldOpenRead, findRead, parseCast, parseDeck, planDeal, type Cast } from "./data/deck";
import { readJsonFile } from "./data/json";
import { loadResults, type ResultsLoad } from "./data/results";
import { parseScan } from "./data/scan";
import { log, warn } from "./log";
import { CLIPS_DIR, DATA_DIR, FILM_PATH, FRAMES_DIR, LOG_DIR, OUT_DIR, RAW_DIR, WORK_DIR } from "./paths";
import { APP_BEATS, beatLabel, finalizeAppBeats, needsRecording, planBeats, type BeatId, type Omission } from "./plan/beats";
import { recordApp } from "./record/app";
import { MARKERS_FILE, loadMarkers, type Markers } from "./record/markers";
import { ServerFleet, startServers } from "./record/servers";
import { assembleFilm, renderAppBeat, renderScene, writeContactSheets, type Clip } from "./render/compose";
import { openStudio } from "./render/studio";
import { closeScene } from "./scenes/close";
import { coldOpenScene } from "./scenes/coldOpen";
import { horoscopeScene } from "./scenes/horoscope";
import { learnedScene } from "./scenes/learned";
import { scanScene } from "./scenes/scan";
import type { Scene } from "./scenes/scene";

type Data = { deck: ReturnType<typeof parseDeck>; cast: Cast; results: ResultsLoad };

const loadData = (): Data => {
  const deck = parseDeck(readJsonFile(join(DATA_DIR, "deck.json"), "deck.json"));
  const cast = parseCast(readJsonFile(join(DATA_DIR, "cast.json"), "cast.json"));
  findRead(deck, cast.featuredReadId, "featuredReadId");
  return { deck, cast, results: loadResults(DATA_DIR) };
};

const sceneFor = (beat: BeatId, data: Data): Scene => {
  const results = data.results.kind === "loaded" ? data.results.results : null;
  switch (beat) {
    case 1:
      return coldOpenScene({ read: coldOpenRead(data.deck, data.cast).text });
    case 3:
      return scanScene(parseScan(readJsonFile(join(DATA_DIR, "scan.json"), "scan.json")));
    case 4: {
      const test = results?.horoscopeTest;
      if (!test) throw new Error(`${beatLabel(4)} was planned without results.horoscopeTest`);
      return horoscopeScene(test);
    }
    case 7: {
      const learning = results?.learning;
      if (!learning) throw new Error(`${beatLabel(7)} was planned without results.learning`);
      const featured = findRead(data.deck, data.cast.featuredReadId, "featuredReadId");
      return learnedScene({ learning, verdict: { read: featured.text, truth: data.cast.truth } });
    }
    case 8:
      return closeScene();
    default:
      throw new Error(`${beatLabel(beat)} is recorded from the app, not rendered as a scene`);
  }
};

const prepareDirs = (reuseRecording: boolean): void => {
  for (const dir of [CLIPS_DIR, FRAMES_DIR, WORK_DIR, LOG_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  if (!reuseRecording) mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
};

const launchBrowser = async (): Promise<Browser> => {
  try {
    return await chromium.launch({ channel: "chromium", headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not launch Chromium (channel "chromium"). If it is not installed, run from demo/: npx playwright install chromium\n${reason}`);
  }
};

type Cleanup = { fleet: ServerFleet; browser: Browser | undefined };

const obtainMarkers = async (args: Args, data: Data, cleanup: Cleanup, browser: Browser): Promise<Markers> => {
  if (args.reuseRecording) {
    const markers = loadMarkers(join(RAW_DIR, MARKERS_FILE));
    const wanted = args.mock ? "mock" : "real";
    if (markers.mode !== wanted) {
      throw new Error(`--reuse-recording found a ${markers.mode} recording, but this run asked for ${wanted}. Drop --reuse-recording or match --mock.`);
    }
    log(`reusing the ${markers.mode} recording of room ${markers.roomCode}`);
    return markers;
  }
  const deal = planDeal(data.deck, data.cast.featuredReadId);
  if (deal.kind === "random") warn(deal.reason);
  if (args.mock) warn("Mock mode: the stage shows the app's own simulated game and built-in demo deck. deck.json and cast.json are not used, and there is no phone view.");
  const servers = await startServers(cleanup.fleet, { mock: args.mock, webPort: args.webPort, roomPort: args.roomPort });
  try {
    return await recordApp({
      browser,
      mode: args.mock ? "mock" : "real",
      webUrl: servers.webUrl,
      roomHost: servers.roomHost,
      cast: data.cast,
      deal,
      rawDir: RAW_DIR,
    });
  } finally {
    await cleanup.fleet.stopAll();
  }
};

const reportPlan = (beats: readonly BeatId[], omitted: readonly Omission[]): void => {
  log(`beats to render: ${beats.join(", ") || "none"}`);
  for (const o of omitted) warn(`omitting ${beatLabel(o.beat)}: ${o.reason}`);
};

const run = async (args: Args, cleanup: Cleanup): Promise<void> => {
  prepareDirs(args.reuseRecording);
  const data = loadData();
  const plan = planBeats(args.beats, data.results);
  reportPlan(plan.beats, plan.omitted);
  const browser = await launchBrowser();
  cleanup.browser = browser;

  let beats = plan.beats;
  const omitted = [...plan.omitted];
  let markers: Markers | undefined;
  if (needsRecording(beats)) {
    markers = await obtainMarkers(args, data, cleanup, browser);
    const finalized = finalizeAppBeats(beats, { hasChain: markers.chainBox !== null });
    beats = finalized.beats;
    omitted.push(...finalized.omitted);
    finalized.omitted.forEach((o) => warn(`omitting ${beatLabel(o.beat)}: ${o.reason}`));
  }
  if (beats.length === 0) throw new Error("Nothing to render: every requested beat was omitted.");

  const studio = await openStudio(browser, WORK_DIR);
  const clips: Clip[] = [];
  try {
    for (const beat of beats) {
      if (APP_BEATS.includes(beat)) {
        if (!markers) throw new Error(`${beatLabel(beat)} needs a recording, but none was made`);
        clips.push(await renderAppBeat(beat, { studio, markers, rawDir: RAW_DIR, clipsDir: CLIPS_DIR, workDir: WORK_DIR }));
      } else {
        clips.push(await renderScene(studio, sceneFor(beat, data), CLIPS_DIR));
      }
    }
  } finally {
    await studio.close();
  }

  const film = await assembleFilm(clips, FRAMES_DIR, FILM_PATH);
  if (args.contactSheet) await writeContactSheets(clips, film.durations, FRAMES_DIR);
  log("done");
  for (const d of film.durations) log(`  ${beatLabel(d.beat)}: ${d.seconds.toFixed(2)}s`);
  for (const o of omitted) log(`  omitted ${beatLabel(o.beat)}: ${o.reason}`);
  log(`film: ${FILM_PATH} (${film.total.toFixed(2)}s)`);
  log(`clips: ${CLIPS_DIR}`);
  log(`review stills: ${FRAMES_DIR}`);
};

const shutdown = async (cleanup: Cleanup): Promise<void> => {
  await cleanup.fleet.stopAll();
  if (cleanup.browser) await cleanup.browser.close();
};

const main = async (): Promise<void> => {
  const cleanup: Cleanup = { fleet: new ServerFleet(), browser: undefined };
  const onSignal = (signal: NodeJS.Signals): void => {
    warn(`received ${signal}, stopping servers and the browser`);
    shutdown(cleanup).then(
      () => process.exit(130),
      (error: unknown) => {
        warn(`cleanup after ${signal} failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(130);
      },
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await run(parseArgs(process.argv.slice(2)), cleanup);
    await shutdown(cleanup);
  } catch (error) {
    process.stderr.write(`\nRENDER FAILED\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    await shutdown(cleanup).catch((cleanupError: unknown) =>
      warn(`cleanup after the failure also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`),
    );
  }
};

await main();
