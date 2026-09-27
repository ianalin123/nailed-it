import { PROTOCOL_VERSION, type ChainStep, type Deck, type Read, type ReadCategory } from "@nailed-it/protocol";

export const DEMO_MODEL_VERSION = "demo-deck-v1";

type DemoRead = {
  text: string;
  category: ReadCategory;
  confidence: number;
  hops: number;
  chain?: ChainStep[];
};

const saw = (text: string): ChainStep => ({ kind: "evidence", text });
const figured = (text: string): ChainStep => ({ kind: "inference", text });

// Invented reads about a fictional person. Nothing here describes a real player.
const DEMO_READS: readonly DemoRead[] = [
  {
    text: "You have a notes file called 'ideas' that is two years long, and you have built almost none of it.",
    category: "work_style",
    confidence: 0.72,
    hops: 1,
    chain: [saw("A file named ideas.md, 2,300 lines long, edited most weeks for two years."), saw("Only four of its headings match a project folder anywhere on the machine."), figured("Ideas get written down fast and started rarely.")],
  },
  {
    text: "You rehearse phone calls in your head, then say something else entirely once they pick up.",
    category: "people_social",
    confidence: 0.64,
    hops: 2,
    chain: [saw("A draft note titled \"what to say to the landlord\" with three versions of the same opening."), saw("The call log shows that call lasted under two minutes."), figured("The script gets rehearsed, then abandoned once the call starts.")],
  },
  {
    text: "You would rather fix a bug at 1am than leave it for the morning.",
    category: "technical_identity",
    confidence: 0.58,
    hops: 2,
    chain: [saw("Most commit timestamps on weeknights fall between 11pm and 2am."), saw("Several commit messages read \"fix before bed\"."), figured("An open bug is harder to sleep on than a late night.")],
  },
  {
    text: "You choose restaurants by reading the one-star reviews first.",
    category: "taste_aesthetics",
    confidence: 0.47,
    hops: 3,
    chain: [saw("Saved screenshots of restaurant reviews, almost all rated one or two stars."), figured("The worst case gets checked before the best case.")],
  },
  {
    text: "You have started at least three sourdough starters and outlived none of them.",
    category: "life_logistics",
    confidence: 0.52,
    hops: 3,
    chain: [saw("Three calendar reminders titled \"feed starter\", each started on a different month."), saw("Each reminder series stops within three weeks."), figured("New routines start with enthusiasm and fade quietly.")],
  },
  {
    text: "You ask the AI to double-check work you already know is right, just to hear it agree.",
    category: "relationship_with_ai",
    confidence: 0.68,
    hops: 2,
    chain: [saw("Chat logs where the question is \"is this right?\" after the answer is already written."), figured("The AI is used for reassurance as much as for answers.")],
  },
  {
    text: "You want to be known for something you have not started yet.",
    category: "ambition_psychology",
    confidence: 0.61,
    hops: 3,
    chain: [saw("A bio draft describes a project that has no files yet."), figured("The identity comes before the work.")],
  },
  {
    text: "Once a month you fall into a long reading spiral about shipwrecks or lost expeditions.",
    category: "intellectual_signature",
    confidence: 0.45,
    hops: 4,
    chain: [saw("Browser bookmarks include eleven articles on lost ships and polar expeditions."), saw("They were saved in bursts, a few weeks apart."), figured("A recurring deep dive, not a passing click.")],
  },
  {
    text: "You are the one who books the group dinner, and you still arrive last.",
    category: "risky_read",
    confidence: 0.55,
    hops: 3,
    chain: [saw("Four restaurant confirmations sent to a group chat this year."), saw("Messages on those evenings say \"five minutes away\" after the booking time."), figured("Organizing and punctuality are different skills here.")],
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
    chain: [saw("Files named final.pdf, final_v2.pdf and final_v3_REAL.pdf in one folder."), figured("Versioning happens by filename, with growing urgency.")],
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
    ...(read.chain ? { chain: read.chain } : {}),
  }));
  return { protocolVersion: PROTOCOL_VERSION, digestId: `demo-${suffix}`, reads };
};
