// Timed caption JSON -> .srt. Accepts both shapes this project runs into.
//
// Three uses:
//
//   1. The popup's "Save transcript only" output -> a file the subtitle-file
//      translator can take. The easiest way to exercise that path.
//   2. Fixtures built from the transcripts already in eval/fixtures.
//   3. A raw `timedtext` json3 response saved out of the browser, which is how
//      an evaluation baseline gets captured by hand — see docs below.
//
// Usage:
//   node tools/transcript-to-srt.mjs <input.json> [out.srt] [options]
//
//   --limit N        keep only the first N cues
//   --from 30:00     drop cues starting before this timestamp
//   --to   40:00     drop cues starting at or after it
//
// Capturing a YouTube baseline by hand, when yt-dlp is rate-limited:
//
//   1. Open the video in Chrome, DevTools -> Network, filter: timedtext
//   2. Press C to turn captions on. One timedtext request appears.
//   3. Right-click it -> Copy -> Copy link address
//   4. In the Console, paste into this and run it:
//
//        const u = new URL("<paste>");
//        u.searchParams.set("tlang", "en");   // YouTube's own translation
//        u.searchParams.set("fmt", "json3");
//        const t = await (await fetch(u)).text();
//        const a = Object.assign(document.createElement("a"), {
//          href: URL.createObjectURL(new Blob([t])), download: "baseline.json3",
//        });
//        a.click();
//
//   5. node tools/transcript-to-srt.mjs baseline.json3 out.srt --from 30:00 --to 40:00
//
// The rewrite in step 4 works because YouTube signs only a fixed parameter set
// (§1.2); `lang`, `kind` and `tlang` are outside it and can be changed on a
// URL that already carries a valid token.

import { readFileSync, writeFileSync } from "node:fs";
import { toSrt } from "../extension/src/core/srt.js";

const args = process.argv.slice(2);

/** Read `--name value`, and remember the value's index so it is not positional. */
const consumed = new Set();
function option(name) {
  const at = args.indexOf(name);
  if (at === -1) return null;
  consumed.add(at).add(at + 1);
  return args[at + 1];
}

/** "40:00", "1:02:03" or a plain seconds count -> ms. */
function toMs(stamp) {
  if (stamp === null || stamp === undefined) return null;
  const parts = String(stamp).split(":").map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Bad timestamp: ${stamp}`);
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}

const limit = Number(option("--limit") ?? Infinity);
const from = toMs(option("--from")) ?? -Infinity;
const to = toMs(option("--to")) ?? Infinity;
const positional = args.filter((a, i) => !consumed.has(i) && !a.startsWith("--"));

const [input, output] = positional;
if (!input) {
  console.error(
    "Usage: node tools/transcript-to-srt.mjs <input.json> [out.srt] [--limit N] [--from 30:00] [--to 40:00]"
  );
  process.exit(1);
}

const data = JSON.parse(readFileSync(input, "utf8"));

/**
 * json3 is YouTube's own wire format: `events`, each with `segs` whose `utf8`
 * pieces concatenate into the line. It carries blank and newline-only events
 * that are not dialogue.
 */
function fromJson3(events) {
  const out = [];
  for (const e of events) {
    const text = (e.segs || []).map((s) => s.utf8).join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ t_ms: e.tStartMs, dur_ms: e.dDurationMs || 0, ja: text });
  }
  return out;
}

const all = Array.isArray(data)
  ? data
  : Array.isArray(data.events)
    ? fromJson3(data.events)
    : data.cues || [];

const shape = Array.isArray(data.events) ? "json3" : "transcript";

const cues = all
  .filter((c) => c.t_ms >= from && c.t_ms < to)
  .slice(0, limit);

if (!cues.length) {
  console.error(
    `No cues in ${input} within the requested range` +
    (from > -Infinity || to < Infinity ? ` (${option("--from") || "start"}–${option("--to") || "end"})` : "") + "."
  );
  process.exit(1);
}

// toSrt wants units and a parallel array of text. The "translation" here is
// whatever language the input holds — this writes one side, not a comparison.
const units = cues.map((c) => ({ start_ms: c.t_ms, end_ms: c.t_ms + (c.dur_ms || 0) }));
const srt = toSrt(units, cues.map((c) => c.ja));

const target = output || input.replace(/\.[^.]+$/, "") + ".srt";
writeFileSync(target, srt, "utf8");

console.log(`${shape}: ${all.length} cues, ${cues.length} kept -> ${target}`);
