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
