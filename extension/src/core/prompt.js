// Prompt construction for both passes.
//
// The rules below are not generic "translate well" advice — each one targets a
// failure category measured on YouTube's own auto-translation in eval/README.md.
// Change them only with a fixture run to back it up.

/**
 * Per-language prompt material.
 *
 * Only the parts that genuinely differ live here. Everything else — output
 * shape, length limits, the ban on inventing content — is language-neutral
 * and stays in one place, because duplicating it per language is how the two
 * drift apart.
 *
 * **The Japanese rules are measured; the Korean ones are not.** Each Japanese
 * rule traces to a scored failure category in eval/README.md. The Korean set
 * is written from the language's structure plus the damage observed in
 * YouTube's own Korean output (eval/korean-findings.md) — severed negation,
 * unstable names — but nothing here has been scored against a Korean reader.
 * Treat it as a first draft that runs, not as a validated prompt.
 */
const LANGUAGES = {
  ja: {
    name: "Japanese",
    forwardContext:
      "in Japanese, what comes next often reveals who or what the current line is about.",
    asrCause: "Japanese homophones are the usual cause.",
    // The measured example: 配信 comes back as "delivery" from YouTube.
    // Kept word-for-word as it was before the prompt was parameterised —
    // this file's rule is that wording changes need a fixture run behind
    // them, and parameterising is not a licence to reword.
    termExample: `For example 配信 is "stream", not "delivery", when the speaker is a streamer.`,
    namesNote: "",
    rules: [
      `Japanese omits subjects constantly and has no verb agreement to recover them from. Decide who or what each line is about using the context above and the reference sheet. Do not default to "I" — it is frequently something on screen, or the person being spoken to.`,
      `Japanese puts negation, tense and politeness at the END of a clause. If a line's meaning depends on a clause that finishes in a later line, translate it so the pair reads correctly together. Never assert the opposite of what was meant.`,
      `Some lines are sentence fragments. Translate a fragment as a fragment that joins onto its neighbours. Do not inflate one into a standalone sentence, and never read a grammatical ending as a name.`,
    ],
  },

  ko: {
    name: "Korean",
    forwardContext:
      "in Korean, what comes next often reveals who or what the current line is about.",
    asrCause:
      "Korean speech recognition usually errs by mis-splitting words (띄어쓰기) or confusing Sino-Korean homophones, rather than by mishearing sounds.",
    termExample: `For example 방송 is "stream", not "a television broadcast", when the speaker is a streamer.`,
    namesNote:
      `\n- Korean names have several accepted romanisations — 이 is Lee or Yi, 박 is Park or Bak, 최 is Choi or Choe. Pick the one the channel itself uses if you can tell, otherwise the most common, and record it so every later line matches.`,
    rules: [
      // Same category as Japanese rule 1, but Korean marks the subject in
      // ways Japanese does not, so the mitigations are different.
      `Korean omits subjects constantly and has no verb agreement to recover them from. Decide who or what each line is about using the context above and the reference sheet. Do not default to "I". Three things in the Korean itself help: the honorific infix -시- marks the subject as someone the speaker defers to, so it is usually NOT the speaker; the speech level marks who is being addressed; and 주다 / 드리다 / -아 주다 mark which direction an action runs.`,
      // The measured failure in YouTube's own Korean output: negation severed
      // from its verb across a cue boundary.
      `Korean puts negation, tense and politeness at the END of a clause, and negation takes several forms — 안 and 못 before the verb, -지 않다 and -지 못하다 as endings. If a line's meaning depends on a clause that finishes in a later line, translate it so the pair reads correctly together. Never assert the opposite of what was meant.`,
      `Some lines are sentence fragments. Translate a fragment as a fragment that joins onto its neighbours. Do not inflate one into a standalone sentence, and never read a particle or a grammatical ending as a name.`,
      // Korean-only. Kinship-as-address is far more pervasive than in
      // Japanese and produces confident nonsense about family when translated
      // literally.
      `Kinship and title words are forms of address, not statements about family. 오빠, 형, 누나, 언니, 선배, -님 and -씨 appear where English uses a name or nothing at all. Do not render 오빠 as "older brother" unless the speaker is genuinely describing a sibling — use the person's name from the reference sheet, or leave it out.`,
      `Speech level carries meaning. A switch between 반말 and 존댓말 marks a change in the relationship — closeness, deference, irritation, or a joke. Put that in the English tone. Never add a note explaining that the level changed.`,
    ],
  },
};

const languageFor = (code) => LANGUAGES[code] || LANGUAGES.ja;

/**
 * Pass 1. Read the whole transcript, produce a glossary and speaker model.
 *
 * This is where consistency comes from. It also, unexpectedly, repairs ASR
 * errors: 高感度イベント is a homophone of 好感度イベント and only one is
 * meaningful in a farming sim — but you have to know it is a farming sim.
 */
export function analysisPrompt(fullSourceText, meta = {}, seed = null) {
  // The transcript carries its own language, so callers that already pass the
  // transcript as `meta` need no new argument.
  const L = languageFor(meta.source_lang || meta.lang);
  const title = meta.title ? `Video title: ${meta.title}\n` : "";
  const author = meta.author ? `Channel: ${meta.author}\n` : "";

  // Names and recurring terms belong to a channel, not to one video. Carrying
  // them across videos is what stops the same streamer being rendered a
  // different way every time.
  const seeded =
    seed && (Object.keys(seed.names || {}).length || Object.keys(seed.terms || {}).length)
      ? `\nALREADY ESTABLISHED FOR THIS CHANNEL. Reuse these spellings exactly, and add to them:\n` +
        JSON.stringify({ names: seed.names || {}, terms: seed.terms || {} }, null, 2) +
        `\n`
      : "";

  return `You are preparing to translate a ${L.name} video transcript into English subtitles.
${seeded}
Before translating, read the whole transcript and build a reference sheet.

${title}${author}
TRANSCRIPT
${fullSourceText}

Produce JSON with exactly these keys:

{
  "setting": "One or two sentences: what is happening, what kind of video, what is being played or discussed. Be specific — this is used to disambiguate homophones later.",
  "speakers": "Who is talking. Note especially whether anyone refers to themselves in the third person by name or nickname, which is common for streamers.",
  "names": { "${L.name.toLowerCase()} term": "how to render it in English, consistently" },
  "terms": { "${L.name.toLowerCase()} term": "English meaning IN THIS CONTEXT, not the dictionary default" },
  "asr_corrections": { "misrecognised form": "what was almost certainly said, and why" },
  "register": "How this speaker sounds, and what English register matches. One or two sentences."
}

Guidance:
- "terms" is for words whose ordinary dictionary sense would be wrong here. ${L.termExample}${L.namesNote}
- "asr_corrections" is for speech-recognition errors you can identify from context. ${L.asrCause} Only list ones you are confident about.
- If a category is empty, use an empty object. Do not invent entries.
- Output only the JSON object. No preamble, no code fence.

Hard limits — a reply that breaks these is useless:
- **This is a reference sheet, NOT a translation.** Do not translate the transcript. Do not add an entry per line.
- Keys in "names", "terms" and "asr_corrections" must be single words or short phrases. Never a whole sentence or a whole line of dialogue.
- At most 12 entries in "names", 15 in "terms", 10 in "asr_corrections". Choose the ones that matter most and leave the rest out.
- Keep the whole reply under 2000 characters.`;
}

/**
 * Pass 2. Translate one chunk, with surrounding units available as context.
 *
 * `echo` asks for {"n": {"ja", "en"}} instead of {"n": "en"}: the model copies
 * each line's Japanese right before its English. On fragmented speech the
 * model otherwise rebuilds whole sentences and spreads the English across
 * neighbouring numbers, shifting every later line; the copy anchors each
 * translation to its own line, and a copy that does not match reveals a
 * shift so the pipeline can reject it. Measured in whisper-subs
 * (docs/benchmarks.md there): a chunk that shifted in 3 of 3 runs was aligned
 * in 3 of 3. Copying only the first few characters was tried and made shifts
 * worse. The text below is kept identical to whisper-subs' prompt.py.
 */
/**
 * Rules that hold whatever the source language is: output shape, length,
 * and the bans on inventing content or translating the context. Kept apart
 * from the per-language set so adding a language cannot quietly fork them.
 */
const GENERIC_RULES = [
  `Use the reference sheet for names and terms, every time, without variation.`,
  `Apply the ASR corrections from the reference sheet where the misrecognised form appears.`,
  `Match the register on the reference sheet. Keep it natural spoken English, not literal glosses.`,
  `Never invent content that is not in the source. If a line is genuinely unclear, translate the part you are sure of.`,
  (L) => `Subtitles are read at speed and get two lines on screen. Keep each translation close to the length of its ${L.name} source and never longer than about 100 characters. Do not explain, expand, add background, or spell out what is merely implied — a line that needs a footnote should still be translated as the line, not the footnote.`,
  `Translate ONLY the numbered lines. The context sections are for understanding; never fold their content into an answer.`,
  `Output plain sentences. No leading or trailing ellipses, no surrounding quotation marks, no speaker labels.`,
];

export function translationPrompt(chunk, glossary, lines = null, { echo = false, lang = "ja" } = {}) {
  const L = languageFor(lang);
  const context = (units, label) =>
    units.length
      ? `${label}\n${units.map((u) => u.ja).join("\n")}\n`
      : "";

  // `lines` carries explicit numbers, so a retry can resend an arbitrary
  // subset of a chunk without the numbering drifting.
  const items =
    lines || chunk.target.map((u, i) => ({ n: chunk.firstUnit + i + 1, ja: u.ja }));

  const numbered = items.map((it) => `${it.n}\t${it.ja}`).join("\n");

  // Speaker changes, where the track marks them. Korean auto-captions carry
  // `>>` on 53% of cues (§8.3) and segment.js turns those into unit
  // boundaries; this is where that reaches the model. Sent as a list of line
  // numbers rather than inline, so the echoed "ja" still matches exactly.
  const asked = new Set(items.map((it) => it.n));
  const turnLines = (chunk.target || [])
    .map((u, i) => (u.turn ? chunk.firstUnit + i + 1 : null))
    .filter((n) => n !== null && asked.has(n));

  const speakerNote = turnLines.length
    ? `\nNEW SPEAKER STARTS AT LINES: ${turnLines.join(", ")}\n` +
      `The caption track marks a change of speaker at these lines. Use it to decide who each line is about — a line after a change is usually NOT the same person as the line before it.\n`
    : "";

  const rules = [...L.rules, ...GENERIC_RULES]
    .map((rule, i) => `${i + 1}. ${typeof rule === "function" ? rule(L) : rule}`)
    .join("\n");

  return `Translate ${L.name} video dialogue into English subtitles.

REFERENCE SHEET
${JSON.stringify(glossary, null, 2)}

${context(chunk.before, "CONTEXT — the lines immediately before (do not translate):")}
${context(chunk.after, `CONTEXT — the lines immediately after (do not translate). Use these: ${L.forwardContext}`)}
LINES TO TRANSLATE
${numbered}
${speakerNote}
Rules:
${rules}

${echo ? replyEcho(items) : replyPlain(items)}`;
}

function replyPlain(items) {
  return `Return JSON mapping each line number to its English translation, and nothing else:

{${items.slice(0, 2).map((it) => `"${it.n}": "..."`).join(", ")}}

Every number listed above must appear exactly once. No preamble, no code fence.`;
}

function replyEcho(items) {
  const example = items
    .slice(0, 2)
    .map((it) => `"${it.n}": {"ja": ${JSON.stringify(it.ja)}, "en": "..."}`)
    .join(", ");
  return `Return JSON mapping each line number to an object holding that line's Japanese, copied exactly, and its English translation, and nothing else:

{${example}}

Every number listed above must appear exactly once, with its own Japanese copied into "ja". Each "en" translates only the Japanese in its own "ja". When a sentence runs across several lines, split the English at the same places. Never move words to a neighbouring line, and never leave a line's "en" empty because its meaning was folded into another line. No preamble, no code fence.`;
}
