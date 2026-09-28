import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const FFMPEG_CANDIDATES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

export const ffmpegPath = (): string => {
  const fromEnv = process.env.FFMPEG;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`FFMPEG is set to ${fromEnv}, but nothing is there.`);
    return fromEnv;
  }
  return FFMPEG_CANDIDATES.find((path) => existsSync(path)) ?? "ffmpeg";
};

const ffprobePath = (): string => ffmpegPath().replace(/ffmpeg$/, "ffprobe");

const tail = (text: string, lines = 25): string => text.trim().split("\n").slice(-lines).join("\n");

const failure = (label: string, command: string, args: readonly string[], code: number | null, stderr: string): Error =>
  new Error(
    `${label}: ${command} exited with code ${code ?? "null"}.\n--- stderr (tail) ---\n${tail(stderr)}\n--- args ---\n${args.join(" ")}`,
  );

const run = (command: string, args: readonly string[], label: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(new Error(`${label}: could not start ${command}: ${error.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(failure(label, command, args, code, stderr))));
  });

export const runFfmpeg = async (args: readonly string[], label: string): Promise<void> => {
  await run(ffmpegPath(), args, label);
};

export const runFfmpegToFile = async (args: readonly string[], out: string, label: string): Promise<void> => {
  rmSync(out, { force: true });
  await runFfmpeg(args, label);
  if (!existsSync(out)) {
    throw new Error(`${label}: ffmpeg exited cleanly but wrote nothing to ${out}. A seek past the last frame is the usual cause.`);
  }
};

export const probeDuration = async (file: string, label: string): Promise<number> => {
  const out = await run(
    ffprobePath(),
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    label,
  );
  const duration = Number(out.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label}: ffprobe reported duration "${out.trim()}" for ${file}`);
  return duration;
};

export const probeVideoSize = async (file: string, label: string): Promise<{ width: number; height: number }> => {
  const out = await run(
    ffprobePath(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file],
    label,
  );
  const match = /^(\d+)x(\d+)/.exec(out.trim());
  if (!match) throw new Error(`${label}: ffprobe reported size "${out.trim()}" for ${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
};

export const runFfmpegBinary = async (args: readonly string[], label: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const command = ffmpegPath();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(new Error(`${label}: could not start ${command}: ${error.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(failure(label, command, args, code, stderr))));
  });

export type FramePipe = { write: (frame: Buffer) => Promise<void>; end: () => Promise<void> };

export const openFramePipe = (args: readonly string[], label: string): FramePipe => {
  const command = ffmpegPath();
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  let exitError: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      exitError = new Error(`${label}: could not start ${command}: ${error.message}`);
      reject(exitError);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        exitError = failure(label, command, args, code, stderr);
        reject(exitError);
      }
    });
  });
  closed.catch(() => undefined);
  return {
    write: (frame) =>
      new Promise((resolve, reject) => {
        if (exitError) {
          reject(exitError);
          return;
        }
        child.stdin.write(frame, (error) => (error ? reject(exitError ?? error) : resolve()));
      }),
    end: async () => {
      child.stdin.end();
      await closed;
    },
  };
};
