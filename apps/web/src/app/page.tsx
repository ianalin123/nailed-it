import { Slip } from "@/components/Slip";
import { Stamp } from "@/components/Stamp";
import { StartForm } from "@/components/home/StartForm";

export default function HomePage() {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-5xl content-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16">
      <section className="flex flex-col gap-6">
        <h1 className="wide font-black leading-[0.85] text-[clamp(4rem,21vw,8.5rem)]">Nailed It</h1>
        <p className="max-w-md text-xl text-field-soft">
          A model reads each of you. The room guesses if it got you right. Then you tell everyone the truth.
        </p>
        <div className="max-w-md -rotate-1">
          <Slip header="card 4 of 12" size="hero" stamp={<Stamp truth="nailed" size="sm" />}>
            You rehearse phone calls in your head, then say something else entirely.
          </Slip>
        </div>
      </section>
      <section>
        <StartForm />
      </section>
    </main>
  );
}
