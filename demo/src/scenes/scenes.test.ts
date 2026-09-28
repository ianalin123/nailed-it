import { describe, expect, it } from "vitest";
import type { Results } from "../data/results";
import type { Scan } from "../data/scan";
import { closeScene } from "./close";
import { coldOpenScene } from "./coldOpen";
import { horoscopeScene } from "./horoscope";
import { learnedScene } from "./learned";
import { scanScene } from "./scan";
import { chainBackground, joinOverlay, playBackground } from "./appStills";
import type { Scene } from "./scene";

type Horoscope = NonNullable<Results["horoscopeTest"]>;
type Learning = NonNullable<Results["learning"]>;

const horoscope: Horoscope = {
  evidenceNote: "Same 40 evidence items",
  unit: "bits",
  base: { label: "Base model", read: "You sometimes doubt yourself.", infoGain: 0.02 },
  trained: { label: "Trained reader", read: "You rehearse calls, then improvise.", infoGain: 1.4 },
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
    expect(chainBackground("real")).toMatch(/How it knew|shows its work/);
  });

  it("labels the phone with the player's name", () => {
    expect(playBackground({ mode: "real", phoneNickname: "Theo" })).toContain("Theo's phone");
    expect(playBackground({ mode: "mock", phoneNickname: null })).not.toContain("phone");
  });
});
