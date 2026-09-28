import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });

describe("honesty rules", () => {
  it("no renderer source file ever names the example results file", () => {
    const offenders = sourceFiles(SRC).filter((path) => readFileSync(path, "utf8").includes("results.example"));
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });

  it("the renderer never reads private training data or the deck candidates doc", () => {
    const forbidden = ["training/data/private", "demo-deck-candidates"];
    const offenders = sourceFiles(SRC).filter((path) => {
      const text = readFileSync(path, "utf8");
      return forbidden.some((needle) => text.includes(needle));
    });
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });
});
