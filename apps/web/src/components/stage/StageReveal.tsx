import { presentChain } from "@/lib/game/chain";
import { confidenceLine, hotSeatPlayer, possessive, revealSummary, roundLabel } from "@/lib/game/selectors";
import { pickTypeSize } from "@/lib/game/stageFit";
import { Stamp } from "../Stamp";
import { REVEAL, fontU, u } from "./geometry";
import { StageChain } from "./StageChain";
import { StageResults } from "./StageResults";
import { StageSlip } from "./StageSlip";
import type { StageProps } from "./types";

export const REVEAL_TIMING = { resultsAt: 900, resultStep: 180, afterResults: 500, chainStep: 900 };

export function StageReveal({ room }: StageProps) {
  const round = room.round;
  const summary = revealSummary(room);
  if (!round || !summary) return null;
  const hotSeat = hotSeatPlayer(room);
  const hasChain = presentChain(round.chain, round.read.text).length > 0;
  const confidence = confidenceLine(summary.readerConfidence);
  const readSize = pickTypeSize(round.read.text.length, REVEAL.readBox, REVEAL.readSteps);
  const confidenceAt = REVEAL_TIMING.resultsAt + summary.rows.length * REVEAL_TIMING.resultStep + REVEAL_TIMING.afterResults;
  const chainAt = confidenceAt + REVEAL_TIMING.afterResults;
  const results = hasChain ? REVEAL.resultsLeft : REVEAL.resultsRight;

  const resultList = (
    <StageResults
      rows={summary.rows}
      fontSizeU={results.rowFontU}
      rowsPerColumn={results.rowsPerColumn}
      maxColumns={hasChain ? 2 : 1}
      startMs={REVEAL_TIMING.resultsAt}
      stepMs={REVEAL_TIMING.resultStep}
    />
  );

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: `${u(REVEAL.leftU)} 1fr`, gap: u(REVEAL.gapU) }}>
      <div className="flex min-h-0 min-w-0 flex-col">
        <h1 className="wide truncate font-black" style={{ ...fontU(REVEAL.headingU, 1), marginBottom: u(1.2) }}>
          {possessive(hotSeat?.nickname ?? "Their")} verdict
        </h1>
        <StageSlip
          header={roundLabel(round)}
          text={round.read.text}
          sizeU={readSize.sizeU}
          pad={{ xU: 2.2, topU: 1.6, bottomU: 3 }}
          stamp={<Stamp key={round.read.id} truth={summary.truth} size="stage" animate />}
        />
        <p
          className="animate-feed font-machine text-field-soft"
          style={{ ...fontU(REVEAL.confidenceU), marginTop: u(0.8), minHeight: u(2.1), maxWidth: u(23), animationDelay: `${confidenceAt}ms` }}
        >
          {confidence ?? ""}
        </p>
        {hasChain ? <div style={{ marginTop: u(1.2) }}>{resultList}</div> : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {hasChain ? (
          <StageChain
            chain={round.chain}
            readText={round.read.text}
            box={REVEAL.chainBox}
            headingU={REVEAL.chainHeadingU}
            startMs={chainAt}
            stepMs={REVEAL_TIMING.chainStep}
          />
        ) : (
          resultList
        )}
      </div>
    </div>
  );
}
