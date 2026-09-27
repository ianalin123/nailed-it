import type { ChainStep } from "@nailed-it/protocol";
import { CHAIN_KIND_LABEL, presentChain } from "@/lib/game/chain";
import { chainLabelWidthU, fitChain, type Box } from "@/lib/game/stageFit";
import { CHAIN_STEP_STYLE } from "../ChainList";
import { cx } from "../cx";
import { fontU, u } from "./geometry";

type StageChainProps = {
  chain: readonly ChainStep[] | undefined;
  readText: string;
  box: Box;
  headingU: number;
  startMs: number;
  stepMs: number;
};

export function StageChain({ chain, readText, box, headingU, startMs, stepMs }: StageChainProps) {
  const fitted = fitChain(presentChain(chain, readText), box);
  if (fitted.items.length === 0) return null;
  const size = fitted.sizeU;
  return (
    <section aria-label="How it knew" className="flex min-h-0 flex-col" style={{ gap: u(0.75) }}>
      <h2 className="wide font-extrabold" style={fontU(headingU)}>
        How it knew
      </h2>
      <ol className="flex flex-col" style={{ gap: u(0.6) }}>
        {fitted.items.map((item, index) => {
          const timing = { animationDelay: `${startMs + index * stepMs}ms` };
          if (item.kind === "more") {
            return (
              <li key="more" className="animate-feed text-field-soft italic" style={{ ...fontU(size), ...timing, paddingInline: u(0.9) }}>
                +{item.count} more {item.count === 1 ? "step" : "steps"}
              </li>
            );
          }
          return (
            <li
              key={item.order}
              className={cx("animate-feed flex items-baseline rounded-md", CHAIN_STEP_STYLE[item.kind])}
              style={{ ...fontU(size), ...timing, paddingInline: u(0.9), paddingBlock: u(0.45) }}
            >
              <span
                className={cx("shrink-0 font-sans font-black not-italic", item.kind === "inference" ? "text-field-soft" : "opacity-70")}
                style={{ width: u(chainLabelWidthU(size)) }}
              >
                {CHAIN_KIND_LABEL[item.kind]}
              </span>
              <span className="min-w-0">{item.text}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
