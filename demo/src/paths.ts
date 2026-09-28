import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(DEMO_DIR, "..");
export const DATA_DIR = join(DEMO_DIR, "data");
export const OUT_DIR = join(DEMO_DIR, "out");
export const CLIPS_DIR = join(OUT_DIR, "clips");
export const FRAMES_DIR = join(OUT_DIR, "frames");
export const RAW_DIR = join(OUT_DIR, "raw");
export const WORK_DIR = join(OUT_DIR, "work");
export const LOG_DIR = join(OUT_DIR, "logs");
export const FILM_PATH = join(OUT_DIR, "nailed-it-demo.mp4");

export const WEB_APP_DIR = join(REPO_DIR, "apps", "web");
export const ROOM_APP_DIR = join(REPO_DIR, "apps", "room");
