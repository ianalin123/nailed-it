import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ActionTone = "nailed" | "partly" | "off" | "primary" | "quiet";

const TONE: Record<ActionTone, string> = {
  nailed: "bg-nailed text-ink",
  partly: "bg-partly text-ink",
  off: "bg-slip text-ink",
  primary: "bg-slip text-ink",
  quiet: "bg-field-deep text-white",
};

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone: ActionTone;
  selected?: boolean;
  big?: boolean;
};

export function ActionButton({ tone, selected = false, big = false, className, children, ...rest }: ActionButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "wide relative w-full rounded-2xl font-extrabold transition-transform duration-100 active:translate-y-0.5",
        "disabled:opacity-45 disabled:active:translate-y-0",
        big ? "min-h-24 px-4 text-[clamp(1.4rem,6vw,2rem)]" : "min-h-14 px-5 text-lg",
        "shadow-[0_5px_0_0_var(--color-field-deep)] active:shadow-[0_2px_0_0_var(--color-field-deep)]",
        selected && "outline-[5px] outline-offset-[3px] outline-white outline-solid",
        TONE[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}
