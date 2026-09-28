import { describe, expect, it } from "vitest";
import { appClipArgs, concatArgs, sceneEncodeArgs, stillArgs, xfadeOffsets } from "./args";

const valueAfter = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe("sceneEncodeArgs", () => {
  it("reads JPEG frames from stdin and writes H.264 at the given rate without audio", () => {
    const args = sceneEncodeArgs({ out: "/o/beat1.mp4", fps: 30, frames: 180 });
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual(["-f", "image2pipe"]);
    expect(valueAfter(args, "-framerate")).toBe("30");
    expect(valueAfter(args, "-i")).toBe("-");
    expect(valueAfter(args, "-c:v")).toBe("libx264");
    expect(valueAfter(args, "-pix_fmt")).toBe("yuv420p");
    expect(valueAfter(args, "-frames:v")).toBe("180");
    expect(args).toContain("-an");
    expect(args.at(-1)).toBe("/o/beat1.mp4");
  });

  it("converts full-range JPEG frames to TV-range yuv420p", () => {
    const args = sceneEncodeArgs({ out: "/o/beat1.mp4", fps: 30, frames: 180 });
    expect(valueAfter(args, "-vf")).toBe("scale=out_range=tv,format=yuv420p");
    expect(valueAfter(args, "-color_range")).toBe("tv");
  });
});

describe("appClipArgs", () => {
  const spec = {
    out: "/o/beat5.mp4",
    duration: 17.25,
    fps: 30,
    background: "/o/bg5.png",
    overlay: "/o/over5.png",
    layers: [
      { file: "/raw/stage.webm", start: 12.6, box: { x: 48, y: 150, width: 1360, height: 766 } },
      {
        file: "/raw/phone.webm",
        start: 12.1,
        box: { x: 1452, y: 70, width: 420, height: 908 },
        mask: "/o/mask.png",
      },
      {
        file: "/raw/stage.webm",
        start: 20,
        box: { x: 0, y: 0, width: 1920, height: 1080 },
        crop: { x: 800, y: 100, width: 1100, height: 550 },
      },
    ],
  };
  const args = appClipArgs(spec);
  const filter = valueAfter(args, "-filter_complex") ?? "";

  it("loops the stills for exactly the clip duration", () => {
    const first = args.indexOf("-loop");
    expect(args.slice(first, first + 2)).toEqual(["-loop", "1"]);
    expect(args.filter((a) => a === "/o/bg5.png")).toHaveLength(1);
  });

  it("seeks each video input to its window start", () => {
    const stageInput = args.indexOf("/raw/stage.webm");
    expect(args[stageInput - 5]).toBe("-ss");
    expect(args[stageInput - 4]).toBe("12.600");
    expect(args[stageInput - 3]).toBe("-t");
    expect(args[stageInput - 2]).toBe("17.250");
  });

  it("scales, crops, masks and overlays each layer at its box", () => {
    expect(filter).toContain("scale=1360:766");
    expect(filter).toContain("overlay=48:150");
    expect(filter).toContain("alphamerge");
    expect(filter).toContain("crop=1100:550:800:100");
    expect(filter).toContain("overlay=1452:70");
  });

  it("puts the transparent overlay last and ends with yuv420p", () => {
    expect(filter.lastIndexOf("overlay=0:0")).toBeGreaterThan(filter.indexOf("alphamerge"));
    expect(filter).toMatch(/format=yuv420p\[out\]$/);
    expect(valueAfter(args, "-map")).toBe("[out]");
  });

  it("trims to the exact duration and frame rate", () => {
    expect(valueAfter(args, "-frames:v")).toBe(String(Math.round(17.25 * 30)));
    expect(valueAfter(args, "-r")).toBe("30");
    expect(args).toContain("-an");
  });

  it("works without an overlay", () => {
    const plain = appClipArgs({ ...spec, overlay: null, layers: [spec.layers[0]!] });
    expect(valueAfter(plain, "-filter_complex")).not.toContain("alphamerge");
  });
});

describe("xfadeOffsets", () => {
  it("places each crossfade before the running end", () => {
    expect(xfadeOffsets([6, 10, 12], 0.25)).toEqual([5.75, 15.5]);
  });

  it("rejects clips shorter than two fades", () => {
    expect(() => xfadeOffsets([6, 0.4, 3], 0.25)).toThrow(/clip 2/);
  });
});

describe("concatArgs", () => {
  it("chains xfade filters across every clip", () => {
    const args = concatArgs({
      clips: [
        { path: "/c/1.mp4", duration: 6 },
        { path: "/c/2.mp4", duration: 10 },
        { path: "/c/3.mp4", duration: 12 },
      ],
      fade: 0.25,
      out: "/o/film.mp4",
      fps: 30,
    });
    const filter = valueAfter(args, "-filter_complex") ?? "";
    expect(filter).toContain("xfade=transition=fade:duration=0.250:offset=5.750");
    expect(filter).toContain("xfade=transition=fade:duration=0.250:offset=15.500");
    expect(args).toContain("+faststart");
    expect(filter).toContain("scale=out_range=tv");
    expect(args.at(-1)).toBe("/o/film.mp4");
  });

  it("re-encodes a single clip without a filter graph", () => {
    const args = concatArgs({ clips: [{ path: "/c/1.mp4", duration: 6 }], fade: 0.25, out: "/o/f.mp4", fps: 30 });
    expect(args).not.toContain("-filter_complex");
  });

  it("refuses an empty film", () => {
    expect(() => concatArgs({ clips: [], fade: 0.25, out: "/o/f.mp4", fps: 30 })).toThrow(/No clips/);
  });
});

describe("stillArgs", () => {
  it("grabs one frame at a time into a PNG", () => {
    const args = stillArgs({ clip: "/c/1.mp4", at: 3.5, out: "/f/1.png" });
    expect(valueAfter(args, "-ss")).toBe("3.500");
    expect(valueAfter(args, "-frames:v")).toBe("1");
    expect(args.at(-1)).toBe("/f/1.png");
  });
});
