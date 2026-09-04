// Prompt construction for both passes.
//
// The rules below are not generic "translate well" advice — each one targets a
// failure category measured on YouTube's own auto-translation in eval/README.md.
// Change them only with a fixture run to back it up.

/**
 * Pass 1. Read the whole transcript, produce a glossary and speaker model.
 *
 * This is where consistency comes from. It also, unexpectedly, repairs ASR
 * errors: 高感度イベント is a homophone of 好感度イベント and only one is
 * meaningful in a farming sim — but you have to know it is a farming sim.
 */
export function analysisPrompt(fullJapaneseText, meta = {}) {
  const title = meta.title ? `Video title: ${meta.title}\n` : "";

  return `You are preparing to translate a Japanese video transcript into English subtitles.

Before translating, read the whole transcript and build a reference sheet.

${title}
TRANSCRIPT
${fullJapaneseText}

Produce JSON with exactly these keys:

{
  "setting": "One or two sentences: what is happening, what kind of video, what is being played or discussed. Be specific — this is used to disambiguate homophones later.",
  "speakers": "Who is talking. Note especially whether anyone refers to themselves in the third person by name or nickname, which is common for streamers.",
  "names": { "japanese term": "how to render it in English, consistently" },
  "terms": { "japanese term": "English meaning IN THIS CONTEXT, not the dictionary default" },
  "asr_corrections": { "misrecognised form": "what was almost certainly said, and why" },
  "register": "How this speaker sounds, and what English register matches. One or two sentences."
}

Guidance:
- "terms" is for words whose ordinary dictionary sense would be wrong here. For example 配信 is "stream", not "delivery", when the speaker is a streamer.
- "asr_corrections" is for speech-recognition errors you can identify from context. Japanese homophones are the usual cause. Only list ones you are confident about.
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
 */
export function translationPrompt(chunk, glossary, lines = null) {
  const context = (units, label) =>
    units.length
      ? `${label}\n${units.map((u) => u.ja).join("\n")}\n`
      : "";

  // `lines` carries explicit numbers, so a retry can resend an arbitrary
  // subset of a chunk without the numbering drifting.
  const items =
    lines || chunk.target.map((u, i) => ({ n: chunk.firstUnit + i + 1, ja: u.ja }));

  const numbered = items.map((it) => `${it.n}\t${it.ja}`).join("\n");

  return `Translate Japanese video dialogue into English subtitles.

REFERENCE SHEET
${JSON.stringify(glossary, null, 2)}

${context(chunk.before, "CONTEXT — the lines immediately before (do not translate):")}
${context(chunk.after, "CONTEXT — the lines immediately after (do not translate). Use these: in Japanese, what comes next often reveals who or what the current line is about.")}
LINES TO TRANSLATE
${numbered}

Rules:
1. Japanese omits subjects constantly and has no verb agreement to recover them from. Decide who or what each line is about using the context above and the reference sheet. Do not default to "I" — it is frequently something on screen, or the person being spoken to.
2. Japanese puts negation, tense and politeness at the END of a clause. If a line's meaning depends on a clause that finishes in a later line, translate it so the pair reads correctly together. Never assert the opposite of what was meant.
3. Some lines are sentence fragments. Translate a fragment as a fragment that joins onto its neighbours. Do not inflate one into a standalone sentence, and never read a grammatical ending as a name.
4. Use the reference sheet for names and terms, every time, without variation.
5. Apply the ASR corrections from the reference sheet where the misrecognised form appears.
6. Match the register on the reference sheet. Keep it natural spoken English, not literal glosses.
7. Never invent content that is not in the source. If a line is genuinely unclear, translate the part you are sure of.
8. Subtitles are read at speed and get two lines on screen. Keep each translation close to the length of its Japanese source and never longer than about 100 characters. Do not explain, expand, add background, or spell out what is merely implied — a line that needs a footnote should still be translated as the line, not the footnote.
9. Translate ONLY the numbered lines. The context sections are for understanding; never fold their content into an answer.
10. Output plain sentences. No leading or trailing ellipses, no surrounding quotation marks, no speaker labels.

Return JSON mapping each line number to its English translation, and nothing else:

{${items.slice(0, 2).map((it) => `"${it.n}": "..."`).join(", ")}}

Every number listed above must appear exactly once. No preamble, no code fence.`;
}
