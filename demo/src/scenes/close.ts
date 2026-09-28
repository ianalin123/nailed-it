import { fadeStyle, feedAt, feedStyle } from "../timeline/motion";
import { slip, stamp, tag } from "./parts";
import type { Scene } from "./scene";

export const CLOSE_COPY = {
  name: "Nailed It",
  line: "A party game where every reveal teaches the reader.",
  builtFor: "Built for",
  tracks: ["Best custom LLM/Agent trained using the River API", "Most Memorable"],
} as const;

const DURATION = 5.5;
const STAMP_AT = 1.1;

export const closeScene = (): Scene => ({
  beat: 8,
  name: "close",
  duration: DURATION,
  stillAt: DURATION - 0.3,
  render: (t) => {
    const card = slip(CLOSE_COPY.line, {
      textSize: 50,
      style: `width:1180px;${feedStyle(feedAt(t, 0.2))}`,
      stamp: stamp("nailed", t, STAMP_AT, 104),
    });
    const tracks = CLOSE_COPY.tracks
      .map((track, i) => `<span style="${fadeStyle(t, 2.3 + i * 0.35)}">${tag(track, "font-size:30px")}</span>`)
      .join("");
    return `<div class="center-stack" style="gap:44px">
      <p class="wide headline" style="font-size:132px;line-height:0.9;${fadeStyle(t, 0, 0.45, 16)}">${CLOSE_COPY.name}</p>
      ${card}
      <div class="tracks" style="${fadeStyle(t, 2.1)}"><span class="tracks-label">${CLOSE_COPY.builtFor}</span>${tracks}</div>
    </div>`;
  },
});
