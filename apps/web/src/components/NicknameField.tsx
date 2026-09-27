import { NICKNAME_MAX } from "@/lib/game/roomCode";

type NicknameFieldProps = { value: string; onChange: (value: string) => void; error: string | undefined };

export function NicknameField({ value, onChange, error }: NicknameFieldProps) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-lg font-semibold">Your name</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={NICKNAME_MAX}
        autoComplete="nickname"
        autoCapitalize="words"
        placeholder="What your friends call you"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "nickname-error" : undefined}
        className="min-h-14 rounded-xl bg-slip px-4 text-xl font-semibold text-ink placeholder:text-ink/45"
      />
      {error ? (
        <span id="nickname-error" role="alert" className="text-alarm">
          {error}
        </span>
      ) : null}
    </label>
  );
}
