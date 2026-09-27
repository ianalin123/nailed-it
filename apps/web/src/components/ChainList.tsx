import type { ChainStep } from "@nailed-it/protocol";
import { CHAIN_KIND_LABEL, presentChain, type PresentedStep } from "@/lib/game/chain";
import { cx } from "./cx";

export const CHAIN_STEP_STYLE: Record<PresentedStep["kind"], string> = {
  evidence: "bg-slip text-ink font-machine",
  inference: "border-l-4 border-field-soft text-white italic",
  read: "bg-nailed text-ink font-bold",
};

export function ChainList({ chain, readText }: { chain: readonly ChainStep[] | undefined; readText: string }) {
  const steps = presentChain(chain, readText);
  if (steps.length === 0) return null;
  return (
    <section aria-label="How it knew" className="flex flex-col gap-2">
      <h2 className="wide text-2xl font-extrabold">How it knew</h2>
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.order} className={cx("flex items-baseline gap-3 rounded-md px-3 py-2 text-base", CHAIN_STEP_STYLE[step.kind])}>
            <span
              className={cx(
                "w-16 shrink-0 font-sans text-xs font-black not-italic",
                step.kind === "inference" ? "text-field-soft" : "opacity-70",
              )}
            >
              {CHAIN_KIND_LABEL[step.kind]}
            </span>
            <span className="min-w-0">{step.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
