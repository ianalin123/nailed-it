import { TRUTH_LABEL } from "@/lib/game/selectors";
import { stampFootprint } from "@/lib/game/stageFit";
import { CONTENT, REVEAL, STAGE_STAMP_TILT, revealLeftColumnU, revealSlipInnerWidthU, stageStampZone } from "./geometry";

describe("stage reveal geometry", () => {
  it("reserves a stamp zone big enough for every verdict at its settled tilt", () => {
    const zone = stageStampZone();
    (["nailed", "partly", "off"] as const).forEach((truth) => {
      const footprint = stampFootprint(TRUTH_LABEL[truth], REVEAL.stampU, STAGE_STAMP_TILT[truth]);
      expect(footprint.widthU).toBeLessThanOrEqual(zone.widthU);
      expect(footprint.heightU).toBeLessThanOrEqual(zone.heightU);
    });
  });

  it("keeps the stamp zone inside the slip, leaving room beside it for the confidence line", () => {
    const zone = stageStampZone();
    expect(zone.widthU + REVEAL.confidenceMinWidthU + REVEAL.footerGapU).toBeLessThanOrEqual(revealSlipInnerWidthU());
  });

  it("fits heading, slip with stamp zone, and results in the content box", () => {
    expect(revealLeftColumnU()).toBeLessThanOrEqual(CONTENT.heightU);
  });
});
