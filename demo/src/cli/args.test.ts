import { describe, expect, it } from "vitest";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  it("defaults to every beat against the real server", () => {
    expect(parseArgs([])).toEqual({
      beats: [1, 2, 3, 4, 5, 6, 7, 8],
      mock: false,
      reuseRecording: false,
      contactSheet: false,
      webPort: 3217,
      roomPort: 8787,
    });
  });

  it("parses a beat subset and mock mode", () => {
    const args = parseArgs(["--beats", "6,1,5", "--mock"]);
    expect(args.beats).toEqual([1, 5, 6]);
    expect(args.mock).toBe(true);
  });

  it("accepts --beats=1,2 form", () => {
    expect(parseArgs(["--beats=1,2"]).beats).toEqual([1, 2]);
  });

  it("parses --contact-sheet", () => {
    expect(parseArgs(["--contact-sheet"]).contactSheet).toBe(true);
  });

  it("parses ports and reuse", () => {
    const args = parseArgs(["--web-port", "4000", "--room-port", "9999", "--reuse-recording"]);
    expect(args).toMatchObject({ webPort: 4000, roomPort: 9999, reuseRecording: true });
  });

  it("rejects unknown beats and unknown flags loudly", () => {
    expect(() => parseArgs(["--beats", "1,9"])).toThrow(/beat "9"/);
    expect(() => parseArgs(["--fast"])).toThrow(/Unknown flag "--fast"/);
    expect(() => parseArgs(["--beats"])).toThrow(/--beats needs a value/);
  });
});
