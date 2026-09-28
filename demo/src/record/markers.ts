import { z } from "zod";
import { parseWith, readJsonFile } from "../data/json";

const epochMs = z.number().int().positive();

const Box = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

const MarkersSchema = z.object({
  mode: z.enum(["real", "mock"]),
  roomCode: z.string().regex(/^[A-Z]{4}$/),
  stage: z.object({ file: z.string().min(1), startedAt: epochMs }),
  phone: z.object({ file: z.string().min(1), startedAt: epochMs, nickname: z.string().min(1) }).nullable(),
  lobbyAt: epochMs,
  lobbyEvents: z.array(epochMs),
  votingAt: epochMs,
  revealAt: epochMs,
  endAt: epochMs,
  chainBox: Box.nullable(),
});

export type Markers = z.infer<typeof MarkersSchema>;

export const MARKERS_FILE = "markers.json";

export const parseMarkers = (raw: unknown): Markers => parseWith(MarkersSchema, raw, MARKERS_FILE);

export const loadMarkers = (path: string): Markers => parseMarkers(readJsonFile(path, MARKERS_FILE));
