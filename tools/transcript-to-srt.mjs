// Saved transcript JSON -> Japanese .srt.
//
// Two uses. It turns the popup's "Save transcript only" output into a file the
// subtitle-file translator can take, which is the easiest way to exercise that
// path without leaving YouTube. And it builds test fixtures from the
// transcripts in eval/fixtures.
//
// Usage:
//   node tools/transcript-to-srt.mjs <transcript.json> [out.srt] [--limit N]

import { readFileSync, writeFileSync } from "node:fs";
import { toSrt } from "../extension/src/core/srt.js";

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt === -1 ? Infinity : Number(args[limitAt + 1]);
const positional = args.filter((a, i) => !a.startsWith("--") && i !== limitAt + 1);

const [input, output] = positional;
if (!input) {
  console.error("Usage: node tools/transcript-to-srt.mjs <transcript.json> [out.srt] [--limit N]");
  process.exit(1);
}

const data = JSON.parse(readFileSync(input, "utf8"));
const cues = (Array.isArray(data) ? data : data.cues || []).slice(0, limit);
if (!cues.length) {
  console.error(`No cues in ${input}.`);
  process.exit(1);
}

// toSrt wants units and a parallel array of text. The "translation" here is the
// Japanese itself — this writes the source side, not a translation.
const units = cues.map((c) => ({
  start_ms: c.t_ms,
  end_ms: c.t_ms + (c.dur_ms || 0),
}));

const srt = toSrt(units, cues.map((c) => c.ja));
const target = output || input.replace(/\.json$/, "") + ".ja.srt";
writeFileSync(target, srt, "utf8");

console.log(`${cues.length} cues -> ${target}`);
