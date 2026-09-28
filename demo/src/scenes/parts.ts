import type { Truth } from "@nailed-it/protocol";
import { stampAt, stampStyle } from "../timeline/motion";
import { escapeHtml, styleOf } from "./scene";

export const TRUTH_LABEL: Record<Truth, string> = { nailed: "Nailed it", partly: "Partly", off: "Way off" };
export const TRUTH_TILT: Record<Truth, number> = { nailed: -9, partly: 6, off: -4 };

type SlipOptions = { header?: string; textSize: number; style?: string; stamp?: string; caret?: boolean };

export const slip = (text: string, options: SlipOptions): string => {
  const header = options.header ? `<div class="slip-header">${escapeHtml(options.header)}</div>` : "";
  const caret = options.caret ? `<span class="caret">&#9612;</span>` : "";
  const stamp = options.stamp ? `<div class="slip-stamp">${options.stamp}</div>` : "";
  return `<figure class="slip" style="${styleOf(options.style)}">${header}<blockquote class="slip-text" style="font-size:${options.textSize}px">${escapeHtml(text)}${caret}</blockquote>${stamp}</figure>`;
};

export const caretOn = (t: number): boolean => Math.floor(t * 2.4) % 2 === 0;

export const stamp = (truth: Truth, t: number, start: number, fontSize: number): string =>
  `<span class="stamp stamp-${truth}" style="font-size:${fontSize}px;${stampStyle(stampAt(t, start, TRUTH_TILT[truth]))}">${escapeHtml(TRUTH_LABEL[truth])}</span>`;

export const tag = (text: string, style = ""): string => `<span class="tag" style="${style}">${escapeHtml(text)}</span>`;
