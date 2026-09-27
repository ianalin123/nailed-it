import type { Notice } from "@/lib/room/session";

type NoticeStackProps = { notices: readonly Notice[]; onDismiss: (id: number) => void };

export function NoticeStack({ notices, onDismiss }: NoticeStackProps) {
  if (notices.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Problems">
      {notices.map((notice) => (
        <li
          key={notice.id}
          role="alert"
          className="flex items-start gap-3 rounded-xl border-l-8 border-nailed bg-slip p-3 text-ink"
        >
          <div className="min-w-0 flex-1">
            <p className="font-bold">{notice.title}</p>
            <p className="mt-0.5 break-words text-sm text-ink/80">{notice.detail}</p>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(notice.id)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold underline underline-offset-2"
          >
            Dismiss
          </button>
        </li>
      ))}
    </ul>
  );
}
