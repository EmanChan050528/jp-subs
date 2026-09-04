// Two-pass orchestration: analyse the whole transcript, then translate chunks.

import { segment } from "./segment.js";
import { chunk } from "./chunk.js";
import { analysisPrompt, translationPrompt } from "./prompt.js";
import { parseJson } from "./backends.js";

/**
 * How much Japanese to show pass 1. The whole transcript is ideal, but a
 * four-hour archive is ~75,000 characters and will not fit any local model's
 * context — and an over-long prompt fails as a truncated, unparseable reply
 * rather than as a clear error.
 */
const MAX_ANALYSIS_CHARS = 6000;

/**
 * Evenly sample units across the whole video rather than taking a prefix, so
 * the glossary still sees names and vocabulary from the end.
 */
function analysisText(units, budget = MAX_ANALYSIS_CHARS) {
  const all = units.map((u) => u.ja);
  const total = all.reduce((n, s) => n + s.length + 1, 0);
  if (total <= budget) return { text: all.join("\n"), sampled: false };

  const step = total / budget;
  const kept = [];
  let used = 0;
  for (let i = 0; i < all.length; i += Math.max(1, Math.round(step))) {
    if (used + all[i].length > budget) break;
    kept.push(all[i]);
    used += all[i].length + 1;
  }
  return { text: kept.join("\n"), sampled: true, keptUnits: kept.length };
}

/** Pass 1: whole-transcript glossary and speaker model. */
export async function analyse(units, backend, meta = {}, log = () => {}, seed = null) {
  const { text, sampled, keptUnits } = analysisText(units);
  log(
    `pass 1: analysing ${units.length} units (${text.length} chars` +
    (sampled ? `, sampled down to ${keptUnits} units` : "") + ")"
  );

  const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
  const useful = (g) =>
    !!g && (typeof g.setting === "string" && g.setting.trim().length > 0 ||
            count(g.names) + count(g.terms) + count(g.asr_corrections) > 0);

  let glossary = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      glossary = parseJson(
        await backend(analysisPrompt(text, meta, seed), { json: true }),
        "analysis pass"
      );
      if (useful(glossary)) break;
      log(`pass 1: attempt ${attempt} came back empty`);
    } catch (err) {
      // A malformed or truncated reply must NOT end the run. Losing the
      // glossary costs quality; throwing here costs every subtitle.
      log(`pass 1: attempt ${attempt} failed — ${err.message.split("\n")[0]}`);
      glossary = null;
    }
  }

  // Pass 1 is the entire quality advantage over per-cue translation. If it is
  // empty the run will still "succeed" and quietly produce worse subtitles, so
  // say so rather than letting it pass.
  if (!useful(glossary)) {
    log("pass 1: WARNING — no glossary. Names, domain terms and ASR");
    log("        corrections will NOT be applied. Translating anyway;");
    log("        expect roughly per-chunk quality.");
    glossary = {};
  } else {
    log(
      `pass 1: ${count(glossary.names)} names, ${count(glossary.terms)} terms, ` +
      `${count(glossary.asr_corrections)} ASR corrections`
    );
  }
  return glossary;
}

/** Pass 2: translate every chunk. Returns an array parallel to `units`. */
export async function translateUnits(
  units, glossary, backend, options = {}, log = () => {}, onProgress = () => {}
) {
  const chunks = chunk(units, options);
  const translations = new Array(units.length).fill("");
  const failures = [];

  /** Ask for a specific set of lines; write whatever comes back. */
  const request = async (c, lines, label) => {
    const raw = await backend(translationPrompt(c, glossary, lines), { json: true });
    const map = parseJson(raw, label);
    let filled = 0;
    for (const line of lines) {
      const value = map[String(line.n)];
      if (typeof value === "string" && value.trim()) {
        translations[line.n - 1] = value.trim();
        filled += 1;
      }
    }
    return filled;
  };

  /** Lines in this chunk that still have no translation. */
  const outstanding = (c) =>
    c.target
      .map((u, i) => ({ n: c.firstUnit + i + 1, ja: u.ja }))
      .filter((line) => !translations[line.n - 1]);

  for (const c of chunks) {
    // Checked between chunks rather than mid-request: a caller that has lost
    // interest (the viewer navigated away) should not keep occupying the GPU.
    if (options.shouldStop && options.shouldStop()) {
      log(`stopped after ${c.index} of ${chunks.length} chunks`);
      return { translations, failures, stopped: true };
    }

    const label = `chunk ${c.index + 1}/${chunks.length}`;
    const total = c.target.length;

    try {
      await request(c, outstanding(c), label);
    } catch (err) {
      log(`${label}: ${err.message}`);
    }

    // Models drop keys from long JSON objects. Re-ask for only the missing
    // lines — a shorter request usually succeeds where the full one did not.
    // Without this the gaps ship as blank subtitles.
    for (let attempt = 1; attempt <= 2 && outstanding(c).length; attempt++) {
      const missing = outstanding(c);
      log(`${label}: retrying ${missing.length} missing line(s)`);
      try {
        await request(c, missing, `${label} retry ${attempt}`);
      } catch (err) {
        log(`${label}: retry ${attempt} failed — ${err.message}`);
      }
    }

    // Hand back what exists so far: subtitles can start showing while the
    // rest of the video is still being translated.
    onProgress(translations, c.index + 1, chunks.length);

    const left = outstanding(c).length;
    if (left) {
      failures.push(`${label}: ${left} of ${total} lines still missing after 2 retries`);
    }
    log(`${label}: ${total - left}/${total} lines`);
  }

  return { translations, failures };
}

export async function run(transcript, backend, options = {}, log = () => {}, onProgress = () => {}) {
  const cues = transcript.cues || [];
  if (!cues.length) throw new Error("Transcript contains no cues.");

  const units = segment(cues, options);
  log(`segmented ${cues.length} cues into ${units.length} units`);

  const glossary = await analyse(units, backend, transcript, log);
  const { translations, failures } = await translateUnits(
    units, glossary, backend, options, log, (partial, done, total) =>
      onProgress({ units, translations: partial, done, total })
  );

  const translated = translations.filter(Boolean).length;
  return { units, glossary, translations, failures, translated };
}
