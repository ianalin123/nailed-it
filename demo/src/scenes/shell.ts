import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { WEB_APP_DIR } from "../paths";

const FONT_STYLESHEETS = [
  "@fontsource-variable/archivo/standard.css",
  "@fontsource/courier-prime/latin-400.css",
  "@fontsource/courier-prime/latin-700.css",
] as const;

const resolveStylesheet = (specifier: string): string => {
  const require = createRequire(import.meta.url);
  const searched = [import.meta.dirname, WEB_APP_DIR];
  for (const base of searched) {
    try {
      const path = require.resolve(specifier, { paths: [base] });
      if (existsSync(path)) return pathToFileURL(path).href;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`Font stylesheet ${specifier} is not installed. Run pnpm install (it is a dependency of @nailed-it/demo).`);
};

const CSS = `
:root {
  --field: #2b3fe0; --field-deep: #1d2bab; --soft: #c9d0ff; --slip: #f2f4f3; --slip-shade: #dfe3e6;
  --ink: #121a5c; --nailed: #ff3d7f; --partly: #ffc21a;
}
html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; color: #fff;
  font-family: "Archivo Variable", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
body.opaque { background: var(--field); }
body.transparent { background: transparent; }
#root { position: relative; width: 1920px; height: 1080px; }
* { box-sizing: border-box; }
.wide { font-stretch: 125%; }
.machine { font-family: "Courier Prime", "Courier New", monospace; }
.soft { color: var(--soft); }
.headline { font-weight: 900; line-height: 1; margin: 0; }
.center-stack { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.slip { position: relative; margin: 0; background: var(--slip); color: var(--ink); text-align: left;
  border-radius: 6px 6px 0 0; --tooth: 14px; padding: 40px 50px calc(var(--tooth) + 28px);
  -webkit-mask: conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) 50% / var(--tooth) 100%;
  mask: conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) 50% / var(--tooth) 100%; }
.slip-header { font-family: "Courier Prime", monospace; color: rgba(18, 26, 92, 0.7); font-size: 24px; margin-bottom: 20px; }
.slip-text { font-family: "Courier Prime", monospace; font-weight: 700; margin: 0; line-height: 1.2; text-wrap: pretty; }
.slip-stamp { display: flex; justify-content: flex-end; margin-top: 22px; padding-right: 4px; }
.caret { color: var(--nailed); margin-left: 2px; }
.stamp { display: inline-block; border-radius: 10px; font-weight: 900; text-transform: uppercase; line-height: 1;
  font-stretch: 125%; mix-blend-mode: multiply; background: rgba(242, 244, 243, 0.4);
  border: 0.09em solid currentColor; padding: 0.14em 0.32em; transform-origin: center; }
.stamp-nailed { color: var(--nailed); }
.stamp-partly { color: #c98400; }
.stamp-off { color: var(--ink); }
.tag { display: inline-block; border: 3px solid var(--soft); color: var(--slip); border-radius: 8px; padding: 6px 14px;
  font-weight: 800; font-stretch: 125%; text-transform: uppercase; letter-spacing: 0.04em; }
.tracks { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 18px; max-width: 1500px; }
.tracks-label { color: var(--soft); font-size: 28px; font-weight: 700; margin-right: 6px; }
.footer-line { position: absolute; left: 0; right: 0; bottom: 48px; text-align: center; font-weight: 900; font-size: 44px; margin: 0; }
.scan-svg { position: absolute; inset: 0; }
.scan-header { position: absolute; left: 80px; top: 56px; }
.cluster-label { position: absolute; width: 300px; text-align: center; font-weight: 800; font-stretch: 125%; font-size: 26px; color: var(--soft); }
.anchor { position: absolute; transform: translateY(-50%); }
.inference { border-left: 4px solid var(--soft); padding: 10px 16px; font-style: italic; font-size: 24px; line-height: 1.25; background: rgba(29, 43, 171, 0.8); }
.ticker { position: absolute; left: 80px; bottom: 44px; margin: 0; font-family: "Courier Prime", monospace; font-size: 26px; color: var(--soft); max-width: 1760px; white-space: nowrap; overflow: hidden; }
.horoscope { position: absolute; inset: 0; padding: 70px 110px; }
.reader-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 90px; margin-top: 56px; }
.reader-column { display: flex; flex-direction: column; gap: 22px; }
.reader-label { font-weight: 800; font-size: 36px; margin: 0; }
.gain { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.gain-caption { font-size: 20px; margin: 0; }
.gain-track { position: relative; height: 30px; background: rgba(29, 43, 171, 0.9); border-radius: 6px; }
.gain-zero { position: absolute; top: -6px; bottom: -6px; width: 3px; background: var(--slip); }
.gain-fill { position: absolute; top: 0; bottom: 0; border-radius: 4px; }
.gain-value { font-weight: 900; font-stretch: 125%; font-size: 40px; }
.caveat { margin: 22px 0 0; font-weight: 600; color: #fff; line-height: 1.2; }
.note { margin-left: 14px; }
.numbers-bars { margin-top: 44px; display: flex; flex-direction: column; gap: 16px; }
.number-row { display: grid; grid-template-columns: 380px 1000px auto; align-items: center; column-gap: 28px; }
.row-label { font-size: 30px; }
.axis-labels { position: relative; height: 30px; }
.axis-labels span { position: absolute; top: 0; transform: translateX(-50%); font-family: "Courier Prime", monospace; font-size: 22px; color: var(--soft); white-space: nowrap; }
.interval { margin-top: 40px; }
.interval-svg { display: block; overflow: visible; }
.interval-svg text { fill: var(--slip); font-family: "Courier Prime", monospace; font-size: 24px; }
.interval-svg .point-label { font-weight: 700; font-size: 28px; }
.interval-svg .zero-label { fill: var(--soft); }
.interval-words { margin: 10px 0 0; font-size: 32px; font-weight: 700; }
.learned { position: absolute; inset: 0; padding: 80px 110px; display: flex; flex-direction: column; gap: 40px; }
.learn-row { display: flex; gap: 80px; justify-content: center; align-items: flex-start; flex: 1; }
.learn-block { flex: 1; max-width: 780px; display: flex; flex-direction: column; gap: 22px; align-items: center; position: relative; }
.drop-zone { height: 380px; width: 100%; display: flex; justify-content: center; align-items: flex-start; }
.falling { transform-origin: top center; }
.tray { width: 560px; height: 90px; border: 4px dashed var(--soft); border-top: none; border-radius: 0 0 18px 18px;
  display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; padding: 10px 18px; }
.tray-edge { display: block; height: 10px; background: var(--slip); opacity: 0.85; border-radius: 2px; }
.counter { font-size: 30px; margin: 0; }
.counter-value { font-weight: 900; font-size: 64px; }
.block-caption { font-size: 30px; font-weight: 700; margin: 0; text-align: center; }
.procedure-card { background: var(--slip); color: var(--ink); border-radius: 12px; padding: 30px 36px; width: 640px; box-shadow: 0 10px 0 var(--field-deep); }
.procedure-title { font-weight: 700; font-size: 30px; margin: 0 0 14px; }
.procedure-steps { margin: 0; padding-left: 34px; font-size: 26px; line-height: 1.4; font-family: "Courier Prime", monospace; min-height: 150px; }
.recall { font-size: 30px; font-weight: 700; margin: 0; text-align: center; }
.recall-arrow { color: var(--nailed); }
.recall-steps { display: block; font-size: 24px; color: var(--soft); font-weight: 400; margin-top: 6px; }
.app-caption { position: absolute; margin: 0; font-weight: 900; font-size: 48px; color: #fff; }
.provenance { position: absolute; }
.screen-frame { position: absolute; border-radius: 10px; background: var(--ink); box-shadow: 0 18px 0 rgba(18, 26, 92, 0.35); }
.phone-body { position: absolute; background: #0b1040; box-shadow: 0 18px 0 rgba(18, 26, 92, 0.35); }
.device-label { position: absolute; margin: 0; font-size: 26px; color: var(--soft); font-weight: 700; }
`;

export const shellHtml = (): string => {
  const links = FONT_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${resolveStylesheet(sheet)}">`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${links}<style>${CSS}</style></head>
<body class="opaque"><div id="root"></div></body></html>`;
};
