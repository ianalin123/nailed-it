import { describe, expect, it } from "vitest";
import type { Results } from "../data/results";
import type { Scan } from "../data/scan";
import { closeScene } from "./close";
import { coldOpenScene } from "./coldOpen";
import { horoscopeScene } from "./horoscope";
import { learnedScene } from "./learned";
import { scanScene } from "./scan";
import { chainOverlay, joinOverlay, playBackground, playCaption } from "./appStills";
import type { Scene } from "./scene";

type Horoscope = NonNullable<Results["horoscopeTest"]>;
type Learning = NonNullable<Results["learning"]>;

const horoscope: Horoscope = {
  evidenceNote: "Same 40 evidence items",
  unit: "bits",
  base: { label: "Base model", read: "You sometimes doubt yourself.", infoGain: 0.02 },
  trained: { label: "Trained reader", read: "You rehearse calls, then improvise.", infoGain: 1.4 },
  difference: null,
  caveat: null,
  sampleNote: null,
};

const measured: Horoscope = {
  evidenceNote: null,
  unit: "nats",
  base: { label: "Base model, untrained", read: null, infoGain: 0.054 },
  trained: { label: "Nailed It reader, step 5", read: null, infoGain: 0.169 },
  difference: { value: 0.114, ciLow: 0.001, ciHigh: 0.227, level: 95 },
  caveat: "Small gain. The 95% interval only just clears zero.",
  sampleNote: "40 decks per reader",
};

const learning: Learning = {
  trainingSet: { before: 212, after: 213 },
  procedure: { title: "Notes before chats", steps: ["Read notes titles", "Match names across chats"] },
  recall: { nextPlayer: "Ada", stepsWithout: null, stepsWith: null },
};

const verdict = { read: "You keep a list of restaurants.", truth: "nailed" as const };

const scan: Scan = {
  subject: "Pat",
  note: "Invented person.",
  sources: [
    { id: "s", label: "Notes" },
    { id: "t", label: "Git history" },
  ],
  evidence: [
    { id: "e1", source: "s", text: "A note called ideas" },
    { id: "e2", source: "t", text: "Commits at 1am" },
    { id: "e3", source: "t", text: "A dead end" },
  ],
  inferences: [{ id: "i1", from: ["e1", "e2"], text: "Late ideas" }],
  reads: [{ id: "r1", from: ["i1"], text: "You write ideas down at night." }],
};

const end = (scene: Scene): string => scene.render(scene.duration);

const allScenes = (): Scene[] => [
  coldOpenScene({ read: "You name files final_v3_REAL.pdf." }),
  scanScene(scan),
  horoscopeScene(horoscope),
  horoscopeScene(measured),
  learnedScene({ learning, verdict }),
  closeScene(),
];

describe("copy rules", () => {
  it("no scene uses an em dash or hype words at any point", () => {
    const hype = /revolution|game.?chang|cutting.?edge|magic|unleash|supercharg|seamless|AI-powered|incredible/i;
    for (const scene of allScenes()) {
      for (const t of [0, scene.duration / 3, scene.duration / 2, scene.duration]) {
        const html = scene.render(t);
        expect(html, scene.name).not.toContain("—");
        expect(html, scene.name).not.toMatch(hype);
      }
    }
  });

  it("every scene is deterministic", () => {
    for (const scene of allScenes()) expect(scene.render(1.234)).toBe(scene.render(1.234));
  });
});

describe("cold open", () => {
  it("types the read, then asks the question", () => {
    const scene = coldOpenScene({ read: "You name files final_v3_REAL.pdf." });
    expect(scene.render(0.2)).not.toContain("Was the machine right?");
    expect(end(scene)).toContain("You name files final_v3_REAL.pdf.");
    expect(end(scene)).toContain("Was the machine right?");
  });

  it("escapes markup in the read", () => {
    expect(end(coldOpenScene({ read: "<b>x</b> & y" }))).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});

describe("scan", () => {
  it("is labelled as a replay", () => {
    expect(scanScene(scan).render(0.5)).toMatch(/Replay/);
  });

  it("ends with every read shown and the dead end faded", () => {
    const html = end(scanScene(scan));
    expect(html).toContain("You write ideas down at night.");
    expect(html).toMatch(/data-id="e3"[^>]*data-dead="true"/);
    expect(html).toMatch(/data-id="e1"[^>]*data-dead="false"/);
  });
});

describe("horoscope test", () => {
  it("shows both reads and a bar under each", () => {
    const html = end(horoscopeScene(horoscope));
    expect(html).toContain("You sometimes doubt yourself.");
    expect(html).toContain("You rehearse calls, then improvise.");
    expect(html.match(/data-bar=/g)).toHaveLength(2);
    expect(html).toContain("1.40 bits");
  });

  it("omits a bar whose information gain is null", () => {
    const html = end(horoscopeScene({ ...horoscope, base: { ...horoscope.base, infoGain: null } }));
    expect(html.match(/data-bar=/g)).toHaveLength(1);
    expect(html).not.toContain("0.02");
  });

  it("omits the evidence note when it is null", () => {
    expect(end(horoscopeScene({ ...horoscope, evidenceNote: null }))).not.toContain("Same 40");
  });

  it("draws a negative gain below zero instead of hiding it", () => {
    const html = end(horoscopeScene({ ...horoscope, base: { ...horoscope.base, infoGain: -0.5 } }));
    expect(html).toContain("-0.50 bits");
    expect(html).toMatch(/data-bar="base"[^>]*data-negative="true"/);
  });
});

describe("it just learned", () => {
  it("counts the training set from before to after", () => {
    const scene = learnedScene({ learning, verdict });
    expect(scene.render(0)).not.toContain("213");
    expect(end(scene)).toContain("213");
  });

  it("omits the training set drop and counter when trainingSet is null", () => {
    const html = end(learnedScene({ learning: { ...learning, trainingSet: null }, verdict }));
    expect(html).not.toContain("data-counter");
    expect(html).not.toContain(verdict.read);
    expect(html).toContain("Notes before chats");
  });

  it("omits the procedure card and the recall when procedure is null", () => {
    const html = end(learnedScene({ learning: { ...learning, procedure: null }, verdict }));
    expect(html).not.toContain("data-procedure");
    expect(html).not.toContain("Ada");
    expect(html).toContain("data-counter");
  });

  it("shows a step count only when both numbers are present", () => {
    expect(end(learnedScene({ learning, verdict }))).not.toMatch(/steps instead of/);
    const both = { ...learning, recall: { nextPlayer: "Ada", stepsWithout: 20, stepsWith: 12 } };
    expect(end(learnedScene({ learning: both, verdict }))).toContain("12 steps instead of 20");
  });

  it("refuses to render with nothing to show", () => {
    expect(() => learnedScene({ learning: { trainingSet: null, procedure: null, recall: null }, verdict })).toThrow(
      /nothing to show/,
    );
  });
});

describe("close", () => {
  it("names both prize tracks", () => {
    const html = end(closeScene());
    expect(html).toContain("Nailed It");
    expect(html).toContain("Best custom LLM/Agent trained using the River API");
    expect(html).toContain("Most Memorable");
  });
});

describe("app stills", () => {
  it("say plainly what was recorded and how", () => {
    expect(joinOverlay("real")).toMatch(/Real app, real server/);
    expect(joinOverlay("mock")).toMatch(/mock mode/);
    expect(chainOverlay("real", { x: 1090, y: 84, width: 806, height: 807 })).toMatch(/shows its work/);
  });

  it("labels the phone with the player's name", () => {
    expect(playBackground({ mode: "real", phoneNickname: "Theo" })).toContain("Theo's phone");
    expect(playBackground({ mode: "mock", phoneNickname: null })).not.toContain("phone");
  });
});

describe("beat 5 captions", () => {
  it("split into the guess and the truth so each matches what is on screen", () => {
    expect(playCaption("guessing", null)).toContain("The room guesses.");
    expect(playCaption("guessing", null)).not.toContain("truth");
    expect(playCaption("revealed", null)).toContain("The hot seat tells the truth.");
  });

  it("the play background no longer carries a caption", () => {
    expect(playBackground({ mode: "real", phoneNickname: "Theo" })).not.toContain("guesses");
  });
});

describe("beat 6 spotlight", () => {
  it("dims everything outside the chain panel and leaves the panel clear", () => {
    const html = chainOverlay("real", { x: 1090, y: 84, width: 806, height: 807 });
    expect(html).toMatch(/data-spotlight[^>]*left:1090px;top:84px;width:806px;height:807px/);
    expect(html).toContain("box-shadow");
  });
});

describe("horoscope test, numbers only", () => {
  const scene = horoscopeScene(measured);
  const html = end(scene);

  it("uses a neutral headline and no horoscope framing when there are no reads", () => {
    expect(html).toContain("Did training help?");
    expect(html).not.toContain("The horoscope test");
    expect(html).not.toContain("fits everyone");
  });

  it("closes on the measured, modest line for an interval that clears zero", () => {
    expect(html).toContain("A small gain. Measured on data it never saw.");
  });

  it("does not claim a gain when the interval includes zero", () => {
    const flat = end(horoscopeScene({ ...measured, difference: { value: 0.05, ciLow: -0.02, ciHigh: 0.12, level: 95 }, trained: { ...measured.trained, infoGain: 0.104 } }));
    expect(flat).not.toContain("A small gain");
    expect(flat).toContain("No clear gain. Measured on data it never saw.");
  });

  it("labels both bars with the reader name and the value at full precision", () => {
    expect(html).toContain("Base model, untrained");
    expect(html).toContain("Nailed It reader, step 5");
    expect(html).toContain("0.054 nats");
    expect(html).toContain("0.169 nats");
    expect(html.match(/data-bar=/g)).toHaveLength(2);
  });

  it("draws the interval with a zero line and states it in words", () => {
    expect(html).toContain("data-interval");
    expect(html).toContain("data-zero-line");
    expect(html).toContain("Difference +0.114 nats. 95% interval +0.001 to +0.227.");
  });

  it("puts the zero label above the axis so it cannot collide with a lower bound next to zero", () => {
    expect(html).toMatch(/<text[^>]*y="28"[^>]*class="zero-label"/);
    expect(html).toMatch(/<text[^>]*y="118"[^>]*>\+0\.001</);
  });

  it("shows the caveat in plain type for the whole beat", () => {
    for (const t of [0.05, scene.duration / 2, scene.duration]) {
      expect(scene.render(t)).toContain("Small gain. The 95% interval only just clears zero.");
    }
    expect(html).toMatch(/data-caveat[^>]*font-size:(3\d|4\d)px/);
  });

  it("shows the sample note", () => {
    expect(html).toContain("40 decks per reader");
  });

  it("never lets a bar grow past its true length", () => {
    const widths = (markup: string): number[] =>
      [...markup.matchAll(/data-bar="[a-z]+"[^>]*data-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    const final = widths(html);
    for (let t = 0; t <= scene.duration; t += 0.1) {
      widths(scene.render(t)).forEach((w, i) => expect(w).toBeLessThanOrEqual((final[i] ?? 0) + 1e-6));
    }
  });

  it("falls back to numbers only when just one read is present", () => {
    const one = end(horoscopeScene({ ...measured, base: { ...measured.base, read: "A read." } }));
    expect(one).toContain("Did training help?");
    expect(one).not.toContain("A read.");
  });
});

describe("horoscope test with reads and an interval", () => {
  const html = end(horoscopeScene({ ...horoscope, difference: { value: 1.38, ciLow: 0.5, ciHigh: 2.1, level: 95 }, caveat: "One run." }));

  it("keeps the horoscope headline and still draws the interval, never bare bars", () => {
    expect(html).toContain("The horoscope test");
    expect(html).toContain("data-interval");
    expect(html).toContain("data-zero-line");
  });

  it("shows the caveat", () => {
    expect(html).toContain("One run.");
  });

  it("uses one shared scale for both bars", () => {
    expect(html).toMatch(/data-bar="base"[^>]*data-scale="([\d.]+)"[\s\S]*data-bar="trained"[^>]*data-scale="\1"/);
  });
});

describe("any horoscope layout with a difference shows the interval", () => {
  it("holds for every combination of reads", () => {
    const d = { value: 0.114, ciLow: 0.001, ciHigh: 0.227, level: 95 as const };
    for (const reads of [[null, null], ["a", "b"], ["a", null]] as const) {
      const html = end(
        horoscopeScene({ ...measured, difference: d, base: { ...measured.base, read: reads[0] }, trained: { ...measured.trained, read: reads[1] } }),
      );
      expect(html).toContain("data-interval");
    }
  });
});

describe("beat 7 combinations", () => {
  const procedureOnly = { trainingSet: null, procedure: learning.procedure, recall: null };

  it("procedure only: no learning or recall claims", () => {
    const html = end(learnedScene({ learning: procedureOnly, verdict }));
    expect(html).toContain("It remembers how it looked.");
    expect(html).toContain("Stored in Memorable");
    expect(html).toContain("Memorable keeps how it found out.");
    expect(html).not.toContain("It just learned");
    expect(html).not.toContain("training label");
    expect(html).not.toContain("Recalled");
    expect(html).not.toContain(verdict.read);
  });

  it("training set only: the learning headline and the verdict drop, no procedure", () => {
    const html = end(learnedScene({ learning: { trainingSet: learning.trainingSet, procedure: null, recall: null }, verdict }));
    expect(html).toContain("It just learned.");
    expect(html).toContain("Every verdict becomes a training label.");
    expect(html).not.toContain("Memorable");
  });

  it("training set and procedure: both, with the learning headline", () => {
    const html = end(learnedScene({ learning: { ...learning, recall: null }, verdict }));
    expect(html).toContain("It just learned.");
    expect(html).toContain("Stored in Memorable");
    expect(html).not.toContain("Recalled");
  });

  it("recall appears only when recall data is present", () => {
    expect(end(learnedScene({ learning: { ...procedureOnly, recall: { nextPlayer: "Ada", stepsWithout: null, stepsWith: null } }, verdict }))).toContain(
      "Recalled for Ada's scan",
    );
  });
});
