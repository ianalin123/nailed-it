import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Guess } from "@nailed-it/protocol";
import type { Browser, BrowserContext, Page } from "playwright";
import { roundScript, type Cast, type DealPlan } from "../data/deck";
import { log } from "../log";
import { FRAME, PHONE_VIEWPORT } from "../plan/layout";
import { TIMING } from "../plan/windows";
import { LOG_DIR } from "../paths";
import { createRoomAsHost, joinAsPlayer, randomRoomCode, type Bot } from "./bots";
import { MARKERS_FILE, parseMarkers, type Markers } from "./markers";
import { SecretBook, findLeaks } from "./secrets";

export type RecordInput = {
  browser: Browser;
  mode: "real" | "mock";
  webUrl: string;
  roomHost: string | null;
  cast: Cast;
  deal: DealPlan;
  rawDir: string;
};

const GUESS_BUTTON: Record<Guess, string> = { nailed: "Nailed it", off: "Way off" };
const MOCK_POST_REVEAL_MS = 8_200;
const REAL_POST_REVEAL_MS = TIMING.minimumRecordingAfterReveal + 500;
const PHONE_DSF = 2;

const HIDE_DEV_TOOLS = `document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = "nextjs-portal { display: none !important; }";
  document.head.appendChild(style);
});`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const sleepUntil = (epochMs: number): Promise<void> => sleep(epochMs - Date.now());

class RecordingError extends Error {}

const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
  log(`recording: ${label}`);
  try {
    return await action();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RecordingError(`Recording failed while ${label}.\n${reason}`);
  }
};

type Watched = { context: BrowserContext; page: Page; startedAt: number; errors: string[]; name: string };

const openWatched = async (
  browser: Browser,
  name: string,
  options: Parameters<Browser["newContext"]>[0],
  consoleLog: string[],
): Promise<Watched> => {
  const context = await browser.newContext(options);
  await context.addInitScript(HIDE_DEV_TOOLS);
  const before = Date.now();
  const page = await context.newPage();
  const startedAt = Math.round((before + Date.now()) / 2);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleLog.push(`[${name}] ${message.type()}: ${message.text()}`);
  });
  return { context, page, startedAt, errors, name };
};

const assertHealthy = (watched: Watched, where: string): void => {
  if (watched.errors.length > 0) {
    throw new Error(`The ${watched.name} page threw during ${where}: ${watched.errors.join(" | ")}`);
  }
};

const screenLeaks = async (pages: readonly Watched[], secrets: SecretBook, checkpoint: string): Promise<void> => {
  for (const watched of pages) {
    const owners = findLeaks(await watched.page.content(), secrets);
    if (owners.length > 0) {
      throw new LeakError(`SECURITY: ${owners.join(", ")} appeared in the ${watched.name} page at "${checkpoint}". The raw recording was deleted.`);
    }
  }
};

class LeakError extends Error {}

const startLobbyPoll = (page: Page, events: number[]): (() => Promise<void>) => {
  let running = true;
  const loop = async (): Promise<void> => {
    let last = "";
    while (running) {
      const summary = await page.evaluate(() => /\d+ here, \d+ decks?/.exec(document.body.innerText)?.[0] ?? "");
      if (summary !== "" && summary !== last) {
        if (last !== "") events.push(Date.now());
        last = summary;
      }
      await sleep(100);
    }
  };
  let failure: unknown;
  const done = loop().catch((error: unknown) => {
    failure = error;
  });
  return async () => {
    running = false;
    await done;
    if (failure !== undefined) throw failure;
  };
};

const waitForLobby = async (stage: Page): Promise<number> => {
  await stage.locator("figure svg").first().waitFor({ state: "visible", timeout: 30_000 });
  return Date.now();
};

const waitForVoting = async (stage: Page, timeout: number): Promise<number> => {
  await stage.getByRole("heading", { name: /in the hot seat$/ }).waitFor({ state: "visible", timeout });
  return Date.now();
};

const waitForReveal = async (stage: Page, timeout: number): Promise<number> => {
  await stage.locator('[aria-label^="Stamped:"]').first().waitFor({ state: "visible", timeout });
  return Date.now();
};

const measureChain = async (stage: Page): Promise<Markers["chainBox"]> => {
  const chain = stage.locator('section[aria-label="How it knew"]');
  if ((await chain.count()) === 0) return null;
  return chain.first().boundingBox();
};

const saveVideo = async (watched: Watched, dest: string): Promise<void> => {
  const video = watched.page.video();
  if (!video) throw new Error(`The ${watched.name} page has no video. recordVideo was not enabled.`);
  await watched.context.close();
  await video.saveAs(dest);
  await video.delete();
};

const stageOptions = (rawDir: string): Parameters<Browser["newContext"]>[0] => ({
  viewport: FRAME,
  deviceScaleFactor: 1,
  recordVideo: { dir: join(rawDir, "tmp"), size: FRAME },
});

const phoneOptions = (rawDir: string): Parameters<Browser["newContext"]>[0] => ({
  viewport: PHONE_VIEWPORT,
  deviceScaleFactor: PHONE_DSF,
  isMobile: true,
  hasTouch: true,
  recordVideo: {
    dir: join(rawDir, "tmp"),
    size: { width: PHONE_VIEWPORT.width * PHONE_DSF, height: PHONE_VIEWPORT.height * PHONE_DSF },
  },
});

type Session = { watched: Watched[]; bots: Bot[]; consoleLog: string[]; secrets: SecretBook };

const joinPhone = async (input: RecordInput, session: Session, room: string): Promise<Watched> => {
  const phone = await openWatched(input.browser, "phone", phoneOptions(input.rawDir), session.consoleLog);
  session.watched.push(phone);
  const origin = new URL(input.webUrl).origin;
  await phone.context.addInitScript(
    ([expectedOrigin, nickname]) => {
      if (window.location.origin === expectedOrigin) window.localStorage.setItem("nailed-it:nickname", nickname);
    },
    [origin, input.cast.phone.nickname] as const,
  );
  await phone.page.goto(`${input.webUrl}/room/${room}`);
  await phone.page.getByRole("heading", { name: "In the room" }).waitFor({ state: "visible", timeout: 20_000 });
  const seat = await phone.page.evaluate((code) => window.localStorage.getItem(`nailed-it:seat:${code}`), room);
  const token: unknown = seat ? (JSON.parse(seat) as { token?: unknown }).token : undefined;
  if (typeof token !== "string") throw new Error("The phone joined but no reconnect token was saved in its localStorage.");
  session.secrets.add(`reconnect token of ${input.cast.phone.nickname} (phone)`, token);
  return phone;
};

const recordReal = async (input: RecordInput, session: Session): Promise<Omit<Markers, "mode">> => {
  const roomHost = input.roomHost;
  if (roomHost === null) throw new Error("Real mode needs a room host");
  const { cast, deal } = input;
  const { room, bot: host } = await step("creating the room as the hot seat player", () =>
    createRoomAsHost(roomHost, cast.hotSeat.nickname, session.secrets),
  );
  session.bots.push(host);
  log(`recording: room ${room}`);

  const stage = await openWatched(input.browser, "stage", stageOptions(input.rawDir), session.consoleLog);
  session.watched.push(stage);
  await step("opening the stage view", () => stage.page.goto(`${input.webUrl}/room/${room}/stage`));
  const lobbyAt = await step("waiting for the stage lobby QR code (beat 2)", () => waitForLobby(stage.page));
  const lobbyEvents: number[] = [];
  const stopPoll = startLobbyPoll(stage.page, lobbyEvents);

  type Arrival = { at: number; run: () => Promise<void> };
  const joined: { phone?: Watched } = {};
  const arrivals: Arrival[] = [
    {
      at: cast.phone.joinAfterMs,
      run: async () => {
        joined.phone = await joinPhone(input, session, room);
      },
    },
    ...cast.guessers.map((g) => ({
      at: g.joinAfterMs,
      run: async () => {
        session.bots.push(await joinAsPlayer(roomHost, room, g.nickname, session.secrets));
      },
    })),
    { at: cast.deckAfterMs, run: async () => host.send({ type: "submit_deck", deck: deal.deck }) },
  ].sort((a, b) => a.at - b.at);
  for (const arrival of arrivals) {
    await sleepUntil(lobbyAt + arrival.at);
    await step(`running a lobby arrival scheduled at +${arrival.at}ms (beat 2)`, arrival.run);
  }
  const playerCount = 2 + cast.guessers.length;
  await step(`waiting for the stage to show "${playerCount} here, 1 deck" (beat 2)`, () =>
    stage.page.getByText(`${playerCount} here, 1 deck`, { exact: true }).waitFor({ state: "visible", timeout: 20_000 }),
  );
  const phonePage = joined.phone;
  if (!phonePage) throw new Error("The phone never joined");
  await screenLeaks(session.watched, session.secrets, "lobby");
  assertHealthy(stage, "the lobby");

  await sleep(cast.lobbyHoldMs);
  await stopPoll();
  host.send({ type: "start", cardsPerPlayer: 1 });
  const votingAt = await step("waiting for the stage to show the first card (beat 5)", () => waitForVoting(stage.page, 20_000));
  const started = await step("reading the dealt card from the host's state (beat 5)", () =>
    host.waitForState("the first round", (s) => s.status === "playing" && s.round !== undefined),
  );
  const readId = started.round?.read.id;
  if (readId === undefined) throw new Error("The game started without a round");
  if (deal.kind === "pinned" && readId !== cast.featuredReadId) {
    throw new Error(`The server dealt "${readId}" but the pinned deck should have dealt "${cast.featuredReadId}". The band pinning in data/deck.ts no longer matches apps/room/src/game/cards.ts.`);
  }

  const script = roundScript(cast);
  const botsByName = new Map(session.bots.map((b) => [b.nickname, b]));
  for (const vote of script.votes) {
    await sleepUntil(votingAt + vote.atMs);
    await step(`casting ${vote.nickname}'s guess "${vote.guess}" (beat 5)`, async () => {
      if (vote.isPhone) {
        await phonePage.page.getByRole("button", { name: GUESS_BUTTON[vote.guess], exact: true }).click({ timeout: 10_000 });
        return;
      }
      const bot = botsByName.get(vote.nickname);
      if (!bot) throw new Error(`No simulated player named ${vote.nickname}`);
      bot.send({ type: "guess", readId, guess: vote.guess });
    });
  }
  const guessers = 1 + cast.guessers.length;
  await step(`waiting for the stage to show "${guessers} of ${guessers}" guessed (beat 5)`, () =>
    stage.page.waitForFunction(
      (n) => document.querySelector('aside[aria-label="Who has guessed"]')?.textContent?.includes(`${n} of ${n}`) === true,
      guessers,
      { timeout: 15_000 },
    ),
  );
  await screenLeaks(session.watched, session.secrets, "voting");

  await sleepUntil(votingAt + script.revealAtMs);
  host.send({ type: "reveal", readId, truth: cast.truth });
  const revealAt = await step("waiting for the stamp on the stage (beat 5)", () => waitForReveal(stage.page, 15_000));
  await sleep(REAL_POST_REVEAL_MS);
  const chainBox = await step("measuring the How it knew chain on the stage (beat 6)", () => measureChain(stage.page));
  await screenLeaks(session.watched, session.secrets, "reveal");
  assertHealthy(stage, "the round");
  assertHealthy(phonePage, "the round");
  const endAt = Date.now();

  await step("saving the stage video", () => saveVideo(stage, join(input.rawDir, "stage.webm")));
  await step("saving the phone video", () => saveVideo(phonePage, join(input.rawDir, "phone.webm")));
  return {
    roomCode: room,
    stage: { file: "stage.webm", startedAt: stage.startedAt },
    phone: { file: "phone.webm", startedAt: phonePage.startedAt, nickname: cast.phone.nickname },
    lobbyAt,
    lobbyEvents,
    votingAt,
    revealAt,
    endAt,
    chainBox,
  };
};

const recordMock = async (input: RecordInput, session: Session): Promise<Omit<Markers, "mode">> => {
  const room = randomRoomCode();
  const stage = await openWatched(input.browser, "stage", stageOptions(input.rawDir), session.consoleLog);
  session.watched.push(stage);
  await step("opening the mock stage view", () => stage.page.goto(`${input.webUrl}/room/${room}/stage`));
  const lobbyAt = await step("waiting for the mock stage lobby QR code (beat 2)", () => waitForLobby(stage.page));
  const lobbyEvents: number[] = [];
  const stopPoll = startLobbyPoll(stage.page, lobbyEvents);
  const votingAt = await step("waiting for the mock host bot to start the game (beat 5)", () => waitForVoting(stage.page, 45_000));
  await stopPoll();
  const revealAt = await step("waiting for the mock hot seat bot to reveal (beat 5)", () => waitForReveal(stage.page, 45_000));
  await sleep(MOCK_POST_REVEAL_MS);
  const chainBox = await step("measuring the How it knew chain on the mock stage (beat 6)", () => measureChain(stage.page));
  assertHealthy(stage, "the mock round");
  const endAt = Date.now();
  await step("saving the stage video", () => saveVideo(stage, join(input.rawDir, "stage.webm")));
  return {
    roomCode: room,
    stage: { file: "stage.webm", startedAt: stage.startedAt },
    phone: null,
    lobbyAt,
    lobbyEvents,
    votingAt,
    revealAt,
    endAt,
    chainBox,
  };
};

const saveFailureScreens = async (watched: readonly Watched[]): Promise<void> => {
  for (const w of watched) {
    if (w.page.isClosed()) continue;
    const path = join(LOG_DIR, `failure-${w.name}.png`);
    await w.page.screenshot({ path }).then(
      () => log(`saved ${path} for diagnosis`),
      (error: unknown) => log(`could not screenshot the ${w.name} page: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
};

const closeAll = async (session: Session): Promise<void> => {
  session.bots.forEach((bot) => bot.close());
  await Promise.all(session.watched.map((w) => w.context.close()));
};

export const recordApp = async (input: RecordInput): Promise<Markers> => {
  rmSync(input.rawDir, { recursive: true, force: true });
  mkdirSync(join(input.rawDir, "tmp"), { recursive: true });
  const session: Session = { watched: [], bots: [], consoleLog: [], secrets: new SecretBook() };
  try {
    const recorded = input.mode === "real" ? await recordReal(input, session) : await recordMock(input, session);
    const markers = parseMarkers({ mode: input.mode, ...recorded });
    writeFileSync(join(input.rawDir, MARKERS_FILE), JSON.stringify(markers, null, 2));
    rmSync(join(input.rawDir, "tmp"), { recursive: true, force: true });
    return markers;
  } catch (error) {
    if (error instanceof LeakError) {
      await closeAll(session);
      rmSync(input.rawDir, { recursive: true, force: true });
    } else {
      await saveFailureScreens(session.watched);
    }
    throw error;
  } finally {
    await closeAll(session);
    writeFileSync(join(LOG_DIR, "browser-console.log"), session.consoleLog.join("\n"));
  }
};
