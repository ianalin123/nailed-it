import { z } from "zod";
import { parseWith } from "./json";

const id = z.string().trim().min(1).max(40);
const text = (max: number) => z.string().trim().min(1).max(max);

const ScanSchema = z.object({
  subject: text(20),
  note: text(80).nullable().default(null),
  sources: z.array(z.object({ id, label: text(24) })).min(1).max(6),
  evidence: z.array(z.object({ id, source: id, text: text(90) })).min(1).max(16),
  inferences: z.array(z.object({ id, from: z.array(id).min(1), text: text(70) })).max(6),
  reads: z.array(z.object({ id, from: z.array(id).min(1), text: text(120) })).min(1).max(3),
});

export type Scan = z.infer<typeof ScanSchema>;

const assertUniqueIds = (scan: Scan): void => {
  const seen = new Set<string>();
  const all = [...scan.sources, ...scan.evidence, ...scan.inferences, ...scan.reads];
  for (const item of all) {
    if (seen.has(item.id)) throw new Error(`scan.json has a duplicate id "${item.id}". Ids must be unique across all kinds.`);
    seen.add(item.id);
  }
};

const assertReferences = (scan: Scan): void => {
  const sources = new Set(scan.sources.map((s) => s.id));
  for (const e of scan.evidence) {
    if (!sources.has(e.source)) throw new Error(`scan.json evidence "${e.id}" names unknown source "${e.source}".`);
  }
  const evidence = new Set(scan.evidence.map((e) => e.id));
  for (const inference of scan.inferences) {
    const missing = inference.from.filter((ref) => !evidence.has(ref));
    if (missing.length > 0) {
      throw new Error(`scan.json inference "${inference.id}" cites unknown evidence: ${missing.join(", ")}`);
    }
  }
  const citable = new Set([...evidence, ...scan.inferences.map((i) => i.id)]);
  for (const read of scan.reads) {
    const missing = read.from.filter((ref) => !citable.has(ref));
    if (missing.length > 0) {
      throw new Error(`scan.json read "${read.id}" cites unknown evidence or inferences: ${missing.join(", ")}`);
    }
  }
};

export const parseScan = (raw: unknown): Scan => {
  const scan = parseWith(ScanSchema, raw, "scan.json");
  assertUniqueIds(scan);
  assertReferences(scan);
  return scan;
};

export const deadEnds = (scan: Scan): string[] => {
  const used = new Set([...scan.inferences.flatMap((i) => i.from), ...scan.reads.flatMap((r) => r.from)]);
  return scan.evidence.filter((e) => !used.has(e.id)).map((e) => e.id);
};
