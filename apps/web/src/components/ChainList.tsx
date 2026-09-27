import type { ChainStep } from "@nailed-it/protocol";
import { CHAIN_KIND_LABEL, presentChain, type PresentedStep } from "@/lib/game/chain";
import { cx } from "./cx";

type ChainListProps = {
  chain: readonly ChainStep[] | undefined;
  readText: string;
  scale: "phone" | "stage";
  animate?: boolean;
  startDelayMs?: number;
  stepDelayMs?: number;
};

const STEP_STYLE: Record<PresentedStep["kind"], string> = {
  evidence: "bg-slip text-ink font-machine",
  inference: "border-l-4 border-field-soft text-white italic",
  read: "bg-nailed text-ink font-bold",
};

export function ChainList({ chain, readText, scale, animate = false, startDelayMs = 0, stepDelayMs = 700 }: ChainListProps) {
  const steps = presentChain(chain, readText);
  if (steps.length === 0) return null;
  const stage = scale === "stage";
  return (
    <section aria-label="How it knew" className={cx("flex flex-col", stage ? "gap-[0.7vw]" : "gap-2")}>
      <h2 className={cx("wide font-extrabold", stage ? "text-[1.9vw]" : "text-2xl")}>How it knew</h2>
      <ol className={cx("flex flex-col", stage ? "gap-[0.6vw]" : "gap-2")}>
        {steps.map((step) => (
          <li
            key={step.order}
            style={animate ? { animationDelay: `${startDelayMs + step.order * stepDelayMs}ms` } : undefined}
            className={cx(
              "flex items-baseline rounded-md",
              stage ? "gap-[0.8vw] px-[0.9vw] py-[0.5vw] text-[1.35vw] leading-snug" : "gap-3 px-3 py-2 text-base",
              STEP_STYLE[step.kind],
              animate && "animate-feed",
            )}
          >
            <span
              className={cx(
                "wide shrink-0 font-sans font-black not-italic",
                stage ? "w-[5.5vw] text-[1vw]" : "w-16 text-xs",
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
