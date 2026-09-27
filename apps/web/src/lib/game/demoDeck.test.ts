import { Deck } from "@nailed-it/protocol";
import { buildDemoDeck } from "./demoDeck";

describe("buildDemoDeck", () => {
  it("produces a deck that passes the protocol schema", () => {
    expect(Deck.safeParse(buildDemoDeck("x1")).success).toBe(true);
  });

  it("gives each submission unique read ids so two demo decks can share a room", () => {
    const first = buildDemoDeck("one").reads.map((read) => read.id);
    const second = buildDemoDeck("two").reads.map((read) => read.id);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });
});

describe("demo deck chains", () => {
  it("gives most reads a chain and leaves some without, so both cases are exercised", () => {
    const reads = buildDemoDeck("c").reads;
    const withChain = reads.filter((read) => read.chain && read.chain.length > 0);
    expect(withChain.length).toBeGreaterThan(reads.length / 2);
    expect(withChain.length).toBeLessThan(reads.length);
  });

  it("starts every chain from evidence", () => {
    buildDemoDeck("c").reads.forEach((read) => {
      if (read.chain) expect(read.chain[0]?.kind).toBe("evidence");
    });
  });
});
