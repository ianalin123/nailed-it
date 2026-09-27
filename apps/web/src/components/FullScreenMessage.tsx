import Link from "next/link";
import type { ReactNode } from "react";

type FullScreenMessageProps = { title: string; children: ReactNode; action?: { href: string; label: string } };

export function FullScreenMessage({ title, children, action = { href: "/", label: "Back to the start" } }: FullScreenMessageProps) {
  return (
    <section role="alert" className="flex flex-col gap-4 py-10">
      <h1 className="wide text-4xl font-black leading-none wrap-anywhere">{title}</h1>
      <div className="max-w-prose text-lg text-field-soft">{children}</div>
      <Link href={action.href} className="self-start font-bold underline underline-offset-4">
        {action.label}
      </Link>
    </section>
  );
}
