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

  for (const c of chunks) {
    const label = `chunk ${c.index + 1}/${chunks.length}`;
    try {
      const raw = await backend(translationPrompt(c, glossary), { json: true });
      const map = parseJson(raw, label);

      let filled = 0;
      c.target.forEach((_, i) => {
        const unitIndex = c.firstUnit + i;
        const value = map[String(unitIndex + 1)];
        if (typeof value === "string" && value.trim()) {
          translations[unitIndex] = value.trim();
          filled += 1;
        }
      });

      // A model that answers with the wrong keys produces a chunk of blank
      // subtitles. Surface it rather than shipping gaps silently.
      if (filled < c.target.length) {
        failures.push(`${label}: ${c.target.length - filled} of ${c.target.length} lines missing`);
      }
      log(`${label}: ${filled}/${c.target.length} lines`);
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
      log(`${label}: FAILED — ${err.message}`);
    }
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
