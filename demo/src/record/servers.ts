import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { LOG_DIR, ROOM_APP_DIR, WEB_APP_DIR } from "../paths";
import { log } from "../log";

type Managed = {
  name: string;
  child: ChildProcess;
  recent: string[];
  file: WriteStream;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
};

const RECENT_LINES = 40;

export class ServerFleet {
  private readonly managed: Managed[] = [];

  start(name: string, command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Managed {
    if (!existsSync(command)) {
      throw new Error(`Cannot start the ${name}: ${command} does not exist. Run pnpm install at the repo root first.`);
    }
    const file = createWriteStream(join(LOG_DIR, `${name.replace(/\s+/g, "-")}.log`));
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const entry: Managed = { name, child, recent: [], file, exit: null };
    const collect = (chunk: Buffer): void => {
      file.write(chunk);
      entry.recent.push(...chunk.toString().split("\n").filter((line) => line.trim().length > 0));
      entry.recent.splice(0, Math.max(0, entry.recent.length - RECENT_LINES));
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("exit", (code, signal) => (entry.exit = { code, signal }));
    child.on("error", (error) => {
      entry.recent.push(`spawn error: ${error.message}`);
      entry.exit = { code: -1, signal: null };
    });
    this.managed.push(entry);
    log(`started ${name} (pid ${child.pid ?? "?"}), log at out/logs/${name.replace(/\s+/g, "-")}.log`);
    return entry;
  }

  describe(entry: Managed): string {
    return `Last lines from the ${entry.name}:\n${entry.recent.map((line) => `  | ${line}`).join("\n")}`;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.managed.map((entry) => stopOne(entry)));
    this.managed.length = 0;
  }
}

const killGroup = (entry: Managed, signal: NodeJS.Signals): void => {
  const pid = entry.child.pid;
  if (pid === undefined || entry.exit !== null) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ESRCH") throw error;
  }
};

const waitForExit = (entry: Managed, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (entry.exit !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    entry.child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const stopOne = async (entry: Managed): Promise<void> => {
  killGroup(entry, "SIGTERM");
  if (!(await waitForExit(entry, 6_000))) {
    log(`${entry.name} ignored SIGTERM, sending SIGKILL`);
    killGroup(entry, "SIGKILL");
    await waitForExit(entry, 3_000);
  }
  entry.file.end();
  log(`stopped ${entry.name}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const portInUse = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

export const assertPortFree = async (port: number, flag: string): Promise<void> => {
  if (await portInUse(port)) {
    throw new Error(`Port ${port} is already in use. Stop whatever is listening there, or pass ${flag} with a free port.`);
  }
};

type ReadyCheck = { url: string; okStatus: (status: number) => boolean; timeoutMs: number };

export const waitUntilReady = async (fleet: ServerFleet, entry: Managed, check: ReadyCheck): Promise<void> => {
  const deadline = Date.now() + check.timeoutMs;
  let lastProblem = "no response yet";
  while (Date.now() < deadline) {
    if (entry.exit !== null) {
      throw new Error(
        `The ${entry.name} exited (code ${entry.exit.code ?? "null"}, signal ${entry.exit.signal ?? "none"}) before ${check.url} was ready.\n${fleet.describe(entry)}`,
      );
    }
    try {
      const response = await fetch(check.url, { signal: AbortSignal.timeout(60_000) });
      if (check.okStatus(response.status)) return;
      lastProblem = `HTTP ${response.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await sleep(700);
  }
  throw new Error(
    `The ${entry.name} was not ready at ${check.url} within ${check.timeoutMs / 1000}s (last: ${lastProblem}).\n${fleet.describe(entry)}`,
  );
};

export type ServerPlan = { mock: boolean; webPort: number; roomPort: number };
export type RunningServers = { webUrl: string; roomHost: string | null };

const bin = (appDir: string, name: string): string => join(appDir, "node_modules", ".bin", name);

const startRoom = async (fleet: ServerFleet, port: number): Promise<string> => {
  await assertPortFree(port, "--room-port");
  const entry = fleet.start("room server", bin(ROOM_APP_DIR, "wrangler"), ["dev", "--port", String(port)], ROOM_APP_DIR, {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
  });
  await waitUntilReady(fleet, entry, {
    url: `http://localhost:${port}/parties/room/WARM`,
    okStatus: (status) => status < 500,
    timeoutMs: 90_000,
  });
  log(`room server ready on localhost:${port}`);
  return `localhost:${port}`;
};

const startWeb = async (fleet: ServerFleet, plan: ServerPlan, roomHost: string | null): Promise<string> => {
  await assertPortFree(plan.webPort, "--web-port");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_ROOM_MOCK: plan.mock ? "1" : "0",
    NEXT_PUBLIC_ROOM_HOST: roomHost ?? "",
  };
  const entry = fleet.start("web server", bin(WEB_APP_DIR, "next"), ["dev", "--port", String(plan.webPort)], WEB_APP_DIR, env);
  const webUrl = `http://localhost:${plan.webPort}`;
  const ok = (status: number): boolean => status === 200;
  await waitUntilReady(fleet, entry, { url: `${webUrl}/`, okStatus: ok, timeoutMs: 180_000 });
  for (const route of ["/room/WARM/stage", "/room/WARM"]) {
    log(`compiling ${route} before recording`);
    await waitUntilReady(fleet, entry, { url: `${webUrl}${route}`, okStatus: ok, timeoutMs: 180_000 });
  }
  log(`web server ready at ${webUrl} (${plan.mock ? "mock mode" : `room host ${roomHost ?? "?"}`})`);
  return webUrl;
};

export const startServers = async (fleet: ServerFleet, plan: ServerPlan): Promise<RunningServers> => {
  const roomHost = plan.mock ? null : await startRoom(fleet, plan.roomPort);
  const webUrl = await startWeb(fleet, plan, roomHost);
  return { webUrl, roomHost };
};
