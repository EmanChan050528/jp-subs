#!/usr/bin/env node
// Build step 2 CLI.
//
//   jpsub segment   <transcript.ja.json>   inspect segmentation, no model calls
//   jpsub translate <transcript.ja.json>   two-pass translation -> .srt + .en.json

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { segment, stats } from "../../extension/src/core/segment.js";
import { chunk } from "../../extension/src/core/chunk.js";
import { makeBackend } from "../../extension/src/core/backends.js";
import { run } from "../../extension/src/core/pipeline.js";
import { toSrt } from "../../extension/src/core/srt.js";

function parseArgs(argv) {
  const [command, input, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { command, input, flags };
}

const USAGE = `jpsub — Japanese transcript to English subtitles

  jpsub segment   <transcript.ja.json> [--show N]
  jpsub translate <transcript.ja.json> [options]

Options:
  --backend <name>    ollama (default) or gemini
  --model <id>        default qwen3.5:9b for ollama, gemini-3.8-flash for gemini
  --size <n>          units translated per request (default 20)
  --context-before <n>  read-only units before  (default 10)
  --context-after <n>   read-only units after   (default 6)
  --limit <n>         only process the first N units — use this first, it is cheap
  --out <dir>         output directory (default: alongside the input)
  --show <n>          segment: print the first N units (default 12)
`;

async function loadTranscript(path) {
  if (!path) throw new Error("No input file given.\n\n" + USAGE);
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.cues)) {
    throw new Error(`${path} has no "cues" array — is it a .ja.json from the extension?`);
  }
  return data;
}

function options(flags) {
  const num = (v, d) => (v === undefined ? d : Number(v));
  return {
    size: num(flags.size, 20),
    contextBefore: num(flags["context-before"], 10),
    contextAfter: num(flags["context-after"], 6),
  };
}

async function cmdSegment(input, flags) {
  const transcript = await loadTranscript(input);
  const units = segment(transcript.cues);
  const s = stats(transcript.cues, units);
  const chunks = chunk(units, options(flags));

  console.log(`\n${transcript.title || transcript.video_id || basename(input)}`);
  console.log(`${"-".repeat(60)}`);
  for (const [k, v] of Object.entries(s)) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
  console.log(`  ${"chunks".padEnd(24)} ${chunks.length}`);

  const show = Number(flags.show ?? 12);
  console.log(`\nFirst ${show} units:`);
  units.slice(0, show).forEach((u, i) => {
    const secs = (u.start_ms / 1000).toFixed(1).padStart(7);
    console.log(`  ${String(i + 1).padStart(3)} ${secs}s [${u.cue_index.length} cue] ${u.ja}`);
  });
  console.log();
}

async function cmdTranslate(input, flags) {
  const transcript = await loadTranscript(input);
  const backendName = flags.backend || "ollama";
  const backend = makeBackend(backendName, flags.model ? { model: flags.model } : {});

  if (flags.limit) {
    const n = Number(flags.limit);
    // Trim by cue so segmentation still sees natural boundaries.
    transcript.cues = transcript.cues.slice(0, n);
    console.log(`(limited to the first ${n} cues)`);
  }

  const log = (m) => console.log(`  ${m}`);
  console.log(`\n${transcript.title || transcript.video_id}`);
  console.log(`backend: ${backendName}${flags.model ? ` (${flags.model})` : ""}`);

  const started = Date.now();
  const result = await run(transcript, backend, options(flags), log);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const outDir = flags.out || dirname(input);
  const stem = basename(input).replace(/\.ja\.json$/, "").replace(/\.json$/, "");

  const srtPath = join(outDir, `${stem}.en.srt`);
  const jsonPath = join(outDir, `${stem}.en.json`);

  await writeFile(srtPath, toSrt(result.units, result.translations), "utf8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        video_id: transcript.video_id,
        title: transcript.title,
        backend: backendName,
        model: flags.model || null,
        generated_at: new Date().toISOString(),
        glossary: result.glossary,
        units: result.units.map((u, i) => ({
          t_ms: u.start_ms,
          end_ms: u.end_ms,
          ja: u.ja,
          en: result.translations[i] || null,
        })),
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`\n  ${result.translated}/${result.units.length} units translated in ${seconds}s`);
  if (result.failures.length) {
    console.log(`\n  ${result.failures.length} problem(s):`);
    for (const f of result.failures) console.log(`    - ${f}`);
  }
  console.log(`\n  ${srtPath}\n  ${jsonPath}\n`);
}

const { command, input, flags } = parseArgs(process.argv.slice(2));

try {
  if (command === "segment") await cmdSegment(input, flags);
  else if (command === "translate") await cmdTranslate(input, flags);
  else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`\nerror: ${err.message}\n`);
  process.exit(1);
}
