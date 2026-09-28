import type { BeatId } from "../plan/beats";

export type Scene = {
  beat: BeatId;
  name: string;
  duration: number;
  stillAt: number;
  render: (t: number) => string;
};

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const styleOf = (...parts: ReadonlyArray<string | false | undefined>): string =>
  parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(";");
