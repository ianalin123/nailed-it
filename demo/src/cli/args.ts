import { ALL_BEATS, isBeatId, type BeatId } from "../plan/beats";

export type Args = {
  beats: BeatId[];
  mock: boolean;
  reuseRecording: boolean;
  contactSheet: boolean;
  webPort: number;
  roomPort: number;
};

const DEFAULTS: Args = { beats: [...ALL_BEATS], mock: false, reuseRecording: false, contactSheet: false, webPort: 3217, roomPort: 8787 };

const parseBeats = (value: string): BeatId[] => {
  const beats = value.split(",").map((part) => {
    const trimmed = part.trim();
    const n = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !isBeatId(n)) {
      throw new Error(`Unknown beat "${trimmed}" in --beats. Beats are ${ALL_BEATS.join(", ")}.`);
    }
    return n;
  });
  return ALL_BEATS.filter((beat) => beats.includes(beat));
};

const parsePort = (flag: string, value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${flag} must be a port from 1024 to 65535, got "${value}"`);
  return port;
};

const splitFlag = (token: string): [string, string | undefined] => {
  const eq = token.indexOf("=");
  return eq < 0 ? [token, undefined] : [token.slice(0, eq), token.slice(eq + 1)];
};

export const parseArgs = (argv: readonly string[]): Args => {
  const args: Args = { ...DEFAULTS, beats: [...DEFAULTS.beats] };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = splitFlag(argv[i] ?? "");
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case "--beats":
        args.beats = parseBeats(takeValue());
        break;
      case "--mock":
        args.mock = true;
        break;
      case "--reuse-recording":
        args.reuseRecording = true;
        break;
      case "--contact-sheet":
        args.contactSheet = true;
        break;
      case "--web-port":
        args.webPort = parsePort(flag, takeValue());
        break;
      case "--room-port":
        args.roomPort = parsePort(flag, takeValue());
        break;
      default:
        throw new Error(
          `Unknown flag "${flag}". Flags: --beats 1,5,6  --mock  --reuse-recording  --contact-sheet  --web-port N  --room-port N`,
        );
    }
  }
  return args;
};
