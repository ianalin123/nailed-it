import { PROTOCOL_VERSION, type Deck, type Read, type ReadCategory } from "@nailed-it/protocol";

export const DEMO_MODEL_VERSION = "demo-deck-v1";

type DemoRead = { text: string; category: ReadCategory; confidence: number; hops: number };

// Invented reads about a fictional person. Nothing here describes a real player.
const DEMO_READS: readonly DemoRead[] = [
  {
    text: "You have a notes file called 'ideas' that is two years long, and you have built almost none of it.",
    category: "work_style",
    confidence: 0.72,
    hops: 1,
  },
  {
    text: "You rehearse phone calls in your head, then say something else entirely once they pick up.",
    category: "people_social",
    confidence: 0.64,
    hops: 2,
  },
  {
    text: "You would rather fix a bug at 1am than leave it for the morning.",
    category: "technical_identity",
    confidence: 0.58,
    hops: 2,
  },
  {
    text: "You choose restaurants by reading the one-star reviews first.",
    category: "taste_aesthetics",
    confidence: 0.47,
    hops: 3,
  },
  {
    text: "You have started at least three sourdough starters and outlived none of them.",
    category: "life_logistics",
    confidence: 0.52,
    hops: 3,
  },
  {
    text: "You ask the AI to double-check work you already know is right, just to hear it agree.",
    category: "relationship_with_ai",
    confidence: 0.68,
    hops: 2,
  },
  {
    text: "You want to be known for something you have not started yet.",
    category: "ambition_psychology",
    confidence: 0.61,
    hops: 3,
  },
  {
    text: "Once a month you fall into a long reading spiral about shipwrecks or lost expeditions.",
    category: "intellectual_signature",
    confidence: 0.45,
    hops: 4,
  },
  {
    text: "You are the one who books the group dinner, and you still arrive last.",
    category: "risky_read",
    confidence: 0.55,
    hops: 3,
  },
  {
    text: "You keep every birthday card anyone has ever given you, in one shoebox.",
    category: "life_logistics",
    confidence: 0.49,
    hops: 4,
  },
  {
    text: "You rename files like final_v3_REAL.pdf and you are not proud of it.",
    category: "work_style",
    confidence: 0.77,
    hops: 1,
  },
  {
    text: "You judge a new app by its font before you try a single feature.",
    category: "taste_aesthetics",
    confidence: 0.6,
    hops: 2,
  },
];

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

export const buildDemoDeck = (suffix: string = randomSuffix()): Deck => {
  const reads: Read[] = DEMO_READS.map((read, index) => ({
    id: `demo-${suffix}-${index + 1}`,
    text: read.text,
    category: read.category,
    confidence: read.confidence,
    evidenceIds: [],
    hops: read.hops,
    modelVersion: DEMO_MODEL_VERSION,
  }));
  return { protocolVersion: PROTOCOL_VERSION, digestId: `demo-${suffix}`, reads };
};
