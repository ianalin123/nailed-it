import { fadeStyle, feedAt, feedStyle } from "../timeline/motion";
import { typed, typingDuration } from "../timeline/timeline";
import { caretOn, slip } from "./parts";
import type { Scene } from "./scene";

export const COLD_OPEN_COPY = { question: "Was the machine right?" } as const;

const FEED_AT = 0.35;
const TYPE_AT = 0.9;
const CPS = 30;
const MIN_DURATION = 6;

export const coldOpenScene = ({ read }: { read: string }): Scene => {
  const typedEnd = TYPE_AT + typingDuration(read, CPS);
  const questionAt = Math.max(3.4, typedEnd + 0.6);
  const duration = Math.max(MIN_DURATION, questionAt + 2.2);
  return {
    beat: 1,
    name: "cold-open",
    duration,
    stillAt: duration - 0.3,
    render: (t) => {
      const text = typed(read, t, TYPE_AT, CPS);
      const typing = t < typedEnd + 0.8;
      const card = slip(text, {
        textSize: 64,
        caret: typing && caretOn(t),
        style: `width:1320px;min-height:260px;${feedStyle(feedAt(t, FEED_AT))}`,
      });
      const question =
        t >= questionAt
          ? `<p class="wide headline" style="font-size:92px;margin-top:64px;${fadeStyle(t, questionAt, 0.5, 18)}">${COLD_OPEN_COPY.question}</p>`
          : "";
      return `<div class="center-stack">${card}${question}</div>`;
    },
  };
};
