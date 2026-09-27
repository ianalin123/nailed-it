import { presentChain, stageReadSize } from "./chain";

describe("presentChain", () => {
  it("keeps the reader's order and ends on the read itself", () => {
    const steps = presentChain(
      [
        { kind: "evidence", text: "E1" },
        { kind: "inference", text: "I1" },
        { kind: "evidence", text: "E2" },
        { kind: "inference", text: "I2" },
      ],
      "The read",
    );
    expect(steps.map((step) => [step.kind, step.text, step.order])).toEqual([
      ["evidence", "E1", 0],
      ["inference", "I1", 1],
      ["evidence", "E2", 2],
      ["inference", "I2", 3],
      ["read", "The read", 4],
    ]);
  });

  it("returns nothing when there is no chain, so the section can be skipped", () => {
    expect(presentChain(undefined, "The read")).toEqual([]);
    expect(presentChain([], "The read")).toEqual([]);
  });
});

describe("stageReadSize", () => {
  it("shrinks type as reads get longer", () => {
    const short = stageReadSize("x".repeat(60));
    const medium = stageReadSize("x".repeat(140));
    const long = stageReadSize("x".repeat(240));
    expect(short).toBe("xl");
    expect(medium).toBe("lg");
    expect(long).toBe("md");
  });
});
