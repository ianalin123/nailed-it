import { PLAY_LAYOUT } from "../plan/layout";
import { tag } from "./parts";
import { escapeHtml } from "./scene";

export type RecordingMode = "real" | "mock";

export const APP_COPY = {
  provenance: {
    real: "Real app, real server. Scripted players.",
    mock: "Real app, mock mode. Scripted players.",
  },
  join: "Everyone joins from their phone.",
  play: "The room guesses. The hot seat tells the truth.",
  bigScreen: "Big screen",
  phone: (name: string) => `${name}'s phone`,
  chain: "Then it shows its work.",
} as const;

const provenance = (mode: RecordingMode, style: string): string =>
  `<div class="provenance" style="${style}">${tag(APP_COPY.provenance[mode], "font-size:20px")}</div>`;

const caption = (text: string, style: string): string =>
  `<p class="app-caption wide" style="${style}">${escapeHtml(text)}</p>`;

export const joinOverlay = (mode: RecordingMode): string =>
  `${caption(APP_COPY.join, "left:64px;bottom:56px")}${provenance(mode, "right:56px;bottom:60px")}`;

export type PlayStillInput = { mode: RecordingMode; phoneNickname: string | null };

export const MOCK_PLAY_STAGE = { x: 160, y: 150, width: 1600, height: 900 } as const;

export const playBackground = ({ mode, phoneNickname }: PlayStillInput): string => {
  const { stage, phone, phoneRadius, bezel } = PLAY_LAYOUT;
  const stageBox = phoneNickname === null ? MOCK_PLAY_STAGE : stage;
  const screenFrame = `<div class="screen-frame" style="left:${stageBox.x - 6}px;top:${stageBox.y - 6}px;width:${stageBox.width + 12}px;height:${stageBox.height + 12}px"></div>`;
  const stageLabel =
    phoneNickname === null
      ? ""
      : `<p class="device-label" style="left:${stageBox.x}px;top:${stageBox.y + stageBox.height + 22}px">${APP_COPY.bigScreen}</p>`;
  const phoneParts =
    phoneNickname === null
      ? ""
      : `<div class="phone-body" style="left:${phone.x - bezel}px;top:${phone.y - bezel}px;width:${phone.width + 2 * bezel}px;height:${phone.height + 2 * bezel}px;border-radius:${phoneRadius + bezel}px"></div>
         <p class="device-label" style="left:${phone.x}px;top:${phone.y + phone.height + bezel + 14}px;width:${phone.width}px;text-align:center">${escapeHtml(APP_COPY.phone(phoneNickname))}</p>`;
  const provenanceStyle = phoneNickname === null ? "right:160px;top:62px" : `right:${1920 - stageBox.x - stageBox.width}px;top:${stageBox.y + stageBox.height + 18}px`;
  return `${caption(APP_COPY.play, `left:${stageBox.x}px;top:52px;font-size:46px`)}${screenFrame}${stageLabel}${phoneParts}${provenance(mode, provenanceStyle)}`;
};

export const chainBackground = (mode: RecordingMode): string =>
  `${caption(APP_COPY.chain, "left:80px;bottom:52px")}${provenance(mode, "right:80px;bottom:58px")}`;

export const phoneMask = (): string => {
  const { phone, phoneRadius } = PLAY_LAYOUT;
  return `<div style="position:absolute;inset:0;background:#000"></div><div style="position:absolute;left:0;top:0;width:${phone.width}px;height:${phone.height}px;background:#fff;border-radius:${phoneRadius}px"></div>`;
};
