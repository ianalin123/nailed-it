import type { ChainStep } from "@nailed-it/protocol";

export type PresentedStep = { kind: ChainStep["kind"] | "read"; text: string; order: number };

export const presentChain = (chain: readonly ChainStep[] | undefined, readText: string): PresentedStep[] => {
  if (!chain || chain.length === 0) return [];
  const steps: PresentedStep[] = chain.map((step, order) => ({ kind: step.kind, text: step.text, order }));
  return [...steps, { kind: "read", text: readText, order: steps.length }];
};

export const CHAIN_KIND_LABEL: Record<PresentedStep["kind"], string> = {
  evidence: "Saw",
  inference: "Figured",
  read: "So",
};

export type ReadSize = "xl" | "lg" | "md";

export const stageReadSize = (text: string): ReadSize => {
  if (text.length <= 90) return "xl";
  if (text.length <= 160) return "lg";
  return "md";
};
