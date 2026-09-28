"""Build a self-contained HTML page for blind-rating "Nailed It" reads.

Reads a pool file (an array of read objects), shuffles it with a seed, and writes a
single-file HTML page with the pool embedded as JSON. The page never learns which
model wrote which read: only `id` and `text` are embedded, and this module never
opens key.json.

Usage:
    python3 make_rating_page.py --pool POOL --out OUT --seed SEED
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
TRAINING_ROOT = TOOLS_DIR.parent
DEFAULT_POOL = TRAINING_ROOT / ".spend" / "blind" / "pool.json"
DEFAULT_OUT = TRAINING_ROOT / ".spend" / "blind" / "rate.html"
DEFAULT_SEED = 20260101

REQUIRED_FIELDS = ("id", "text", "category", "confidence")
MAX_TEXT_LENGTH = 240


class PoolValidationError(ValueError):
    """Raised when a pool file is not shaped the way the rating page expects."""


class OutputNotIgnoredError(RuntimeError):
    """Raised when the requested output path is not covered by a .gitignore rule."""


def load_pool(path: Path) -> list[dict]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PoolValidationError(f"could not read pool file {path}: {exc}") from exc
    try:
        pool = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PoolValidationError(f"pool file {path} is not valid JSON: {exc}") from exc
    validate_pool(pool)
    return pool


def validate_pool(pool: object) -> None:
    if not isinstance(pool, list):
        raise PoolValidationError("pool must be a JSON array of read objects")
    if len(pool) == 0:
        raise PoolValidationError("pool is empty: at least one read is required")

    seen_ids: set[str] = set()
    for index, entry in enumerate(pool):
        if not isinstance(entry, dict):
            raise PoolValidationError(f"entry {index} must be a JSON object")

        for field in REQUIRED_FIELDS:
            if field not in entry:
                raise PoolValidationError(f"entry {index} is missing required field '{field}'")

        entry_id = entry["id"]
        if not isinstance(entry_id, str) or not entry_id.strip():
            raise PoolValidationError(f"entry {index} has an invalid 'id': must be a non-empty string")
        if entry_id in seen_ids:
            raise PoolValidationError(f"duplicate id '{entry_id}' found in pool")
        seen_ids.add(entry_id)

        text = entry["text"]
        if not isinstance(text, str) or not text.strip():
            raise PoolValidationError(f"entry {index} ('{entry_id}') has an invalid 'text': must be a non-empty string")
        if len(text) > MAX_TEXT_LENGTH:
            raise PoolValidationError(f"entry {index} ('{entry_id}') has 'text' longer than {MAX_TEXT_LENGTH} characters")

        category = entry["category"]
        if not isinstance(category, str) or not category.strip():
            raise PoolValidationError(f"entry {index} ('{entry_id}') has an invalid 'category': must be a non-empty string")

        confidence = entry["confidence"]
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise PoolValidationError(f"entry {index} ('{entry_id}') has an invalid 'confidence': must be a number")
        if not (0.0 <= float(confidence) <= 1.0):
            raise PoolValidationError(f"entry {index} ('{entry_id}') has 'confidence' {confidence} outside the range 0..1")


def shuffle_pool(pool: list[dict], seed: int) -> list[dict]:
    shuffled = list(pool)
    random.Random(seed).shuffle(shuffled)
    return shuffled


def compute_pool_hash(pool: list[dict]) -> str:
    canonical = sorted(
        (
            {"id": entry["id"], "text": entry["text"], "category": entry["category"], "confidence": entry["confidence"]}
            for entry in pool
        ),
        key=lambda entry: entry["id"],
    )
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _embed_json(value: object) -> str:
    """Serialize for inline embedding in a <script> tag, guarding against a stray '</script>'."""
    return json.dumps(value, ensure_ascii=True).replace("</", "<\\/")


def render_html(shuffled_pool: list[dict], seed: int, pool_hash: str) -> str:
    embedded_pool = [{"id": entry["id"], "text": entry["text"]} for entry in shuffled_pool]
    html = _TEMPLATE
    html = html.replace("__POOL_JSON__", _embed_json(embedded_pool))
    html = html.replace("__SEED__", str(int(seed)))
    html = html.replace("__POOL_HASH_JSON__", _embed_json(pool_hash))
    return html


def _nearest_existing_dir(path: Path) -> Path:
    for candidate in (path, *path.parents):
        if candidate.exists():
            return candidate
    return Path(path.anchor or "/")


def ensure_path_is_git_ignored(path: Path) -> None:
    resolved = path.resolve()
    cwd = _nearest_existing_dir(resolved.parent)
    try:
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(resolved)],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise OutputNotIgnoredError(f"could not run `git check-ignore` to verify {resolved} is ignored: {exc}") from exc

    if result.returncode == 0:
        return
    if result.returncode == 1:
        raise OutputNotIgnoredError(
            f"refusing to write output at {resolved}: it is not covered by any .gitignore rule. "
            "Write it under a gitignored path (for example training/.spend/blind/) instead."
        )
    raise OutputNotIgnoredError(
        f"refusing to write output at {resolved}: `git check-ignore` could not determine ignore status "
        f"(exit {result.returncode}): {result.stderr.strip()}"
    )


def build(pool_path: Path, out_path: Path, seed: int) -> Path:
    pool = load_pool(pool_path)
    shuffled = shuffle_pool(pool, seed)
    pool_hash = compute_pool_hash(pool)
    html = render_html(shuffled, seed, pool_hash)

    ensure_path_is_git_ignored(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return out_path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a self-contained blind-rating HTML page from a read pool.")
    parser.add_argument("--pool", type=Path, default=DEFAULT_POOL, help=f"path to pool.json (default: {DEFAULT_POOL})")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"path to write rate.html (default: {DEFAULT_OUT})")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"shuffle seed (default: {DEFAULT_SEED})")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        out_path = build(args.pool, args.out, args.seed)
    except (PoolValidationError, OutputNotIgnoredError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {out_path}")
    return 0


_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind rating</title>
<style>
:root {
  --cobalt: #2c3fe0;
  --paper: #f2f4f3;
  --ink: #141a5c;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--cobalt);
  color: var(--paper);
  min-height: 100%;
  overflow-x: hidden;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100vh;
  padding: 24px 16px;
}
.wrap {
  width: 100%;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  align-items: stretch;
}
h1 { margin: 0; font-size: clamp(22px, 5vw, 30px); }
p { margin: 0; line-height: 1.5; font-size: clamp(15px, 3.5vw, 17px); }
.center-text { text-align: center; }
.slip {
  background: var(--paper);
  color: var(--ink);
  border-radius: 4px;
  padding: clamp(20px, 5vw, 40px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: clamp(18px, 4vw, 26px);
  line-height: 1.5;
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: left;
  word-break: break-word;
}
.progress {
  text-align: center;
  font-size: 14px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.85;
}
.answers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.answers .full { grid-column: 1 / -1; }
button.big {
  font-size: clamp(16px, 3vw, 20px);
  padding: 18px 12px;
  border-radius: 8px;
  border: 2px solid transparent;
  cursor: pointer;
  font-weight: 600;
  font-family: inherit;
}
.btn-nailed { background: #1f9d55; color: #fff; }
.btn-partly { background: #d9a300; color: #141a5c; }
.btn-off { background: #d64545; color: #fff; }
.btn-skip { background: transparent; color: var(--paper); border-color: var(--paper); }
.big.active { box-shadow: inset 0 0 0 3px #141a5c; }
.nav { display: flex; justify-content: space-between; gap: 12px; }
.nav button { flex: 1; background: rgba(255, 255, 255, 0.12); color: var(--paper); }
button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
.notice {
  background: #fff3cd;
  color: #6b4e00;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 14px;
}
ul { margin: 0; padding-left: 20px; font-size: 16px; line-height: 1.6; }
@media (prefers-reduced-motion: no-preference) {
  button.big { transition: transform 0.08s ease, filter 0.08s ease; }
  button.big:active { transform: scale(0.97); }
}
@media (max-width: 420px) {
  .answers { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div id="app" role="main"></div>
<script>
(function () {
  "use strict";

  var POOL = __POOL_JSON__;
  var SEED = __SEED__;
  var POOL_HASH = __POOL_HASH_JSON__;
  var STORAGE_KEY = "nailed-it-blind-ratings-" + POOL_HASH;

  var state = {
    screen: "intro",
    index: 0,
    answers: {},
    msSpent: {},
    cardEnteredAt: null,
    storageAvailable: true,
  };

  function safeLoad() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          state.answers = parsed.answers || {};
          state.msSpent = parsed.msSpent || {};
        }
      }
    } catch (err) {
      state.storageAvailable = false;
    }
  }

  function safeSave() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ answers: state.answers, msSpent: state.msSpent }));
    } catch (err) {
      state.storageAvailable = false;
    }
  }

  function currentRead() {
    return POOL[state.index];
  }

  function enterCurrentCard() {
    state.cardEnteredAt = performance.now();
  }

  function leaveCurrentCard() {
    if (state.cardEnteredAt !== null) {
      var id = currentRead().id;
      var delta = performance.now() - state.cardEnteredAt;
      state.msSpent[id] = (state.msSpent[id] || 0) + delta;
      state.cardEnteredAt = null;
    }
  }

  function goTo(newIndex) {
    if (state.screen !== "rating") return;
    leaveCurrentCard();
    state.index = Math.max(0, Math.min(POOL.length - 1, newIndex));
    enterCurrentCard();
    render();
  }

  function setAnswer(answer) {
    if (state.screen !== "rating") return;
    var read = currentRead();
    leaveCurrentCard();
    state.answers[read.id] = {
      answer: answer,
      order: state.index + 1,
      ms: Math.round(state.msSpent[read.id] || 0),
    };
    safeSave();
    if (state.index >= POOL.length - 1) {
      state.screen = "summary";
      render();
      return;
    }
    state.index += 1;
    enterCurrentCard();
    render();
  }

  function startRating() {
    state.screen = "rating";
    state.index = 0;
    enterCurrentCard();
    render();
  }

  function finishNow() {
    leaveCurrentCard();
    state.screen = "summary";
    render();
  }

  function summaryCounts() {
    var counts = { nailed: 0, partly: 0, off: 0, skip: 0 };
    Object.keys(state.answers).forEach(function (id) {
      var a = state.answers[id].answer;
      if (counts[a] !== undefined) counts[a] += 1;
    });
    return counts;
  }

  function exportRatings() {
    var ratings = [];
    POOL.forEach(function (read) {
      var rec = state.answers[read.id];
      if (rec) ratings.push({ id: read.id, answer: rec.answer, order: rec.order, ms: rec.ms });
    });

    var payload = {
      poolHash: POOL_HASH,
      exportedAt: new Date().toISOString(),
      seed: SEED,
      ratings: ratings,
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "ratings.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function renderIntro() {
    var root = document.getElementById("app");
    root.innerHTML = "";
    root.appendChild(
      h("div", { class: "wrap" }, [
        h("h1", { class: "center-text", text: "Blind rating" }),
        h("p", { text: "You'll see short statements written about you, one at a time, in a random order. You won't be told who wrote which one." }),
        h("p", { text: "For each one, mark it Nailed it, Partly, or Way off. You can skip any of them, and change an answer any time by going back." }),
        h("p", { text: "It takes about ten minutes. Nothing here leaves this computer: there are no network requests, no fonts loaded from elsewhere, and no accounts." }),
        h("p", { text: "You can stop early with Finish now and still export what you've rated so far." }),
        h("button", { class: "big btn-nailed", text: "Start", onclick: startRating }),
      ])
    );
  }

  function renderRating() {
    var root = document.getElementById("app");
    root.innerHTML = "";
    var read = currentRead();
    var existing = state.answers[read.id];

    function answerButton(cls, label, key, value) {
      var isActive = existing && existing.answer === value;
      return h("button", {
        class: "big " + cls + (isActive ? " active" : ""),
        text: label + " (" + key + ")",
        "aria-pressed": isActive ? "true" : "false",
        onclick: function () { setAnswer(value); },
      });
    }

    var notice = !state.storageAvailable
      ? h("div", { class: "notice", role: "status", text: "Local storage is unavailable in this browser, so answers are kept only in memory for this session. Export before closing the tab." })
      : null;

    var children = [
      h("div", { class: "progress", "aria-live": "polite", text: (state.index + 1) + " of " + POOL.length }),
      h("div", { class: "slip", text: read.text }),
      h("div", { class: "answers" }, [
        answerButton("btn-nailed", "Nailed it", "1", "nailed"),
        answerButton("btn-partly", "Partly", "2", "partly"),
        answerButton("btn-off", "Way off", "3", "off"),
        answerButton("btn-skip full", "Skip", "S", "skip"),
      ]),
      h("div", { class: "nav" }, [
        h("button", { class: "big", text: "← Prev", "aria-label": "Previous read", onclick: function () { goTo(state.index - 1); } }),
        h("button", { class: "big", text: "Finish now", onclick: finishNow }),
        h("button", { class: "big", text: "Next →", "aria-label": "Next read", onclick: function () { goTo(state.index + 1); } }),
      ]),
    ];
    if (notice) children.push(notice);

    root.appendChild(h("div", { class: "wrap" }, children));
  }

  function renderSummary() {
    var root = document.getElementById("app");
    root.innerHTML = "";
    var counts = summaryCounts();
    var rated = counts.nailed + counts.partly + counts.off;

    root.appendChild(
      h("div", { class: "wrap" }, [
        h("h1", { class: "center-text", text: "Done" }),
        h("p", { text: "You rated " + rated + " of " + POOL.length + " (plus " + counts.skip + " skipped)." }),
        h("ul", {}, [
          h("li", { text: "Nailed it: " + counts.nailed }),
          h("li", { text: "Partly: " + counts.partly }),
          h("li", { text: "Way off: " + counts.off }),
          h("li", { text: "Skipped: " + counts.skip }),
        ]),
        h("button", { class: "big btn-nailed", text: "Export my ratings", onclick: exportRatings }),
        h("p", { text: "After it downloads, move ratings.json into the .spend/blind/ folder." }),
        h("button", { class: "big", text: "Back to rating", onclick: function () { state.screen = "rating"; enterCurrentCard(); render(); } }),
      ])
    );
  }

  function render() {
    if (state.screen === "intro") renderIntro();
    else if (state.screen === "rating") renderRating();
    else renderSummary();
  }

  function boot() {
    safeLoad();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  document.addEventListener("keydown", function (event) {
    if (state.screen !== "rating") return;
    var key = event.key.toLowerCase();
    if (key === "1") setAnswer("nailed");
    else if (key === "2") setAnswer("partly");
    else if (key === "3") setAnswer("off");
    else if (key === "s") setAnswer("skip");
    else if (event.key === "ArrowLeft") goTo(state.index - 1);
    else if (event.key === "ArrowRight") goTo(state.index + 1);
  });
})();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    raise SystemExit(main())
