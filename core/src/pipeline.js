// Two-pass orchestration: analyse the whole transcript, then translate chunks.

import { segment } from "./segment.js";
import { chunk } from "./chunk.js";
import { analysisPrompt, translationPrompt } from "./prompt.js";
import { parseJson } from "./backends.js";

/** Pass 1: whole-transcript glossary and speaker model. */
export async function analyse(units, backend, meta = {}, log = () => {}) {
  const text = units.map((u) => u.ja).join("\n");
  log(`pass 1: analysing ${units.length} units (${text.length} chars)`);

  const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
  const useful = (g) =>
    !!g && (typeof g.setting === "string" && g.setting.trim().length > 0 ||
            count(g.names) + count(g.terms) + count(g.asr_corrections) > 0);

  let glossary = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    glossary = parseJson(await backend(analysisPrompt(text, meta), { json: true }), "analysis pass");
    if (useful(glossary)) break;
    if (attempt === 1) log("pass 1: came back empty, retrying once");
  }

  // Pass 1 is the entire quality advantage over per-cue translation. If it is
  // empty the run will still "succeed" and quietly produce worse subtitles, so
  // say so rather than letting it pass.
  if (!useful(glossary)) {
    log("pass 1: WARNING — glossary is empty. Names, domain terms and ASR");
    log("        corrections will NOT be applied. Output is roughly");
    log("        per-chunk translation. Try a larger model.");
    glossary = glossary || {};
  } else {
    log(
      `pass 1: ${count(glossary.names)} names, ${count(glossary.terms)} terms, ` +
      `${count(glossary.asr_corrections)} ASR corrections`
    );
  }
  return glossary;
}

/** Pass 2: translate every chunk. Returns an array parallel to `units`. */
export async function translateUnits(units, glossary, backend, options = {}, log = () => {}) {
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

    const left = outstanding(c).length;
    if (left) {
      failures.push(`${label}: ${left} of ${total} lines still missing after 2 retries`);
    }
    log(`${label}: ${total - left}/${total} lines`);
  }

  return { translations, failures };
}

export async function run(transcript, backend, options = {}, log = () => {}) {
  const cues = transcript.cues || [];
  if (!cues.length) throw new Error("Transcript contains no cues.");

  const units = segment(cues, options);
  log(`segmented ${cues.length} cues into ${units.length} units`);

  const glossary = await analyse(units, backend, transcript, log);
  const { translations, failures } = await translateUnits(
    units, glossary, backend, options, log
  );

  const translated = translations.filter(Boolean).length;
  return { units, glossary, translations, failures, translated };
}
