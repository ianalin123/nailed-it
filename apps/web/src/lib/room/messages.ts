import { parseServerMessage, type ServerMessage } from "@nailed-it/protocol";

export type DecodeResult = { ok: true; message: ServerMessage } | { ok: false; detail: string };

const MAX_DETAIL_LENGTH = 300;

const truncate = (text: string): string =>
  text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;

const parseJson = (data: string): { ok: true; value: unknown } | { ok: false; detail: string } => {
  try {
    return { ok: true, value: JSON.parse(data) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Not valid JSON (${reason}): ${truncate(data)}` };
  }
};

export const decodeServerMessage = (data: unknown): DecodeResult => {
  if (typeof data !== "string") {
    return { ok: false, detail: `Expected a text message, got ${typeof data}.` };
  }
  const json = parseJson(data);
  if (!json.ok) return json;
  const parsed = parseServerMessage(json.value);
  if (parsed.success) return { ok: true, message: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, detail: truncate(issues) };
};
