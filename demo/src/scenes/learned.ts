import type { Truth } from "@nailed-it/protocol";
import type { Results } from "../data/results";
import { fadeStyle } from "../timeline/motion";
import { countUp, cubicBezier, lerp, progress, typed } from "../timeline/timeline";
import { slip, stamp, tag } from "./parts";
import { escapeHtml, type Scene } from "./scene";

type Learning = NonNullable<Results["learning"]>;
type TrainingSet = NonNullable<Learning["trainingSet"]>;
type Procedure = NonNullable<Learning["procedure"]>;
type Recall = NonNullable<Learning["recall"]>;

export type Verdict = { read: string; truth: Truth };

export const LEARNED_COPY = {
  title: "It just learned.",
  procedureTitle: "It remembers how it looked.",
  verdictCaption: "Every verdict becomes a training label.",
  counterLabel: "verdicts in the training set",
  procedureCaption: "Memorable keeps how it found out.",
  stored: "Stored in Memorable",
  recalled: (name: string) => `Recalled for ${name}'s scan`,
  steps: (withMemory: number, without: number) => `${withMemory} steps instead of ${without}`,
} as const;

const drop = cubicBezier(0.5, 0, 0.75, 0);

const trainingBlock = (set: TrainingSet, verdict: Verdict, start: number) => {
  const landAt = start + 1.6;
  const countAt = landAt + 0.1;
  return {
    end: countAt + 1.2,
    render: (t: number): string => {
      const fall = drop(progress(t, start + 0.5, landAt - start - 0.5));
      const y = lerp(0, 330, fall);
      const scale = lerp(1, 0.55, fall);
      const landed = t >= landAt;
      const card = landed
        ? ""
        : `<div class="falling" style="transform:translateY(${y.toFixed(1)}px) scale(${scale.toFixed(3)});${fadeStyle(t, start, 0.3)}">${slip(verdict.read, { textSize: 30, style: "width:640px", stamp: stamp(verdict.truth, t, start + 0.15, 54) })}</div>`;
      const count = countUp(set.before, set.after, progress(t, countAt, 0.6));
      const pulse = t >= countAt && t < countAt + 0.6 ? "color:var(--nailed)" : "";
      return `<section class="learn-block" style="${fadeStyle(t, start)}">
          <div class="drop-zone">${card}</div>
          <div class="tray"><span class="tray-edge"></span><span class="tray-edge"></span><span class="tray-edge"></span></div>
          <p class="counter" data-counter="true"><span class="wide counter-value" style="${pulse}">${count.toLocaleString("en-US")}</span> <span class="soft">${LEARNED_COPY.counterLabel}</span></p>
          <p class="block-caption" style="${fadeStyle(t, countAt + 0.3)}">${LEARNED_COPY.verdictCaption}</p>
        </section>`;
    },
  };
};

const recallLine = (recall: Recall, t: number, at: number): string => {
  if (t < at) return "";
  const steps =
    recall.stepsWith !== null && recall.stepsWithout !== null
      ? `<span class="machine recall-steps">${escapeHtml(LEARNED_COPY.steps(recall.stepsWith, recall.stepsWithout))}</span>`
      : "";
  return `<p class="recall" style="${fadeStyle(t, at)}"><span class="recall-arrow">&#8594;</span> ${escapeHtml(LEARNED_COPY.recalled(recall.nextPlayer))} ${steps}</p>`;
};

const procedureBlock = (procedure: Procedure, recall: Recall | null, start: number) => {
  const stepAt = (i: number): number => start + 0.7 + i * 0.55;
  const storedAt = stepAt(procedure.steps.length) + 0.3;
  const recallAt = storedAt + 1.0;
  return {
    end: recall ? recallAt + 1.4 : storedAt + 1.4,
    render: (t: number): string => {
      const steps = procedure.steps
        .map((step, i) => (t >= stepAt(i) ? `<li style="${fadeStyle(t, stepAt(i))}">${escapeHtml(typed(step, t, stepAt(i), 60))}</li>` : ""))
        .join("");
      const stored = t >= storedAt ? `<div style="${fadeStyle(t, storedAt)}">${tag(LEARNED_COPY.stored, "font-size:22px")}</div>` : "";
      return `<section class="learn-block" data-procedure="true" style="${fadeStyle(t, start)}">
          <div class="procedure-card">
            <p class="machine procedure-title">${escapeHtml(procedure.title)}</p>
            <ol class="procedure-steps">${steps}</ol>
          </div>
          ${stored}
          <p class="block-caption" style="${fadeStyle(t, start + 0.4)}">${LEARNED_COPY.procedureCaption}</p>
          ${recall ? recallLine(recall, t, recallAt) : ""}
        </section>`;
    },
  };
};

export const learnedScene = ({ learning, verdict }: { learning: Learning; verdict: Verdict }): Scene => {
  const training = learning.trainingSet ? trainingBlock(learning.trainingSet, verdict, 0.7) : null;
  const procedureStart = training ? training.end - 0.6 : 0.7;
  const procedure = learning.procedure ? procedureBlock(learning.procedure, learning.recall, procedureStart) : null;
  if (!training && !procedure) {
    throw new Error("Beat 7 has nothing to show: results.json learning needs a trainingSet or a procedure.");
  }
  const end = Math.max(training?.end ?? 0, procedure?.end ?? 0);
  const duration = Math.max(8, end + 1.2);
  return {
    beat: 7,
    name: "it-just-learned",
    duration,
    stillAt: duration - 0.3,
    render: (t) => `<div class="learned">
        <h1 class="wide headline" style="font-size:80px;margin:0;${fadeStyle(t, 0)}">${training ? LEARNED_COPY.title : LEARNED_COPY.procedureTitle}</h1>
        <div class="learn-row">${training ? training.render(t) : ""}${procedure ? procedure.render(t) : ""}</div>
      </div>`,
  };
};
