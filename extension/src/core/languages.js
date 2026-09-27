// The source languages this project knows about, and what it can do with each.
//
// Two separate capabilities, because they became separate the moment Korean
// was measured:
//
//   extract   — pull the caption track off YouTube. Language-agnostic; the
//               interceptor rewrites `lang` on a signed URL and does not care
//               what it points at.
//   translate — run the two-pass pipeline. Needs a prompt written for the
//               language's actual failure modes (§3.3), which exists only for
//               Japanese.
//
// Korean is extractable today and not translatable. Saying so precisely is
// the point of this file: the extension used to report a Korean video as
// having "no Japanese caption track", which is true and useless.

export const LANGUAGES = {
  ja: {
    code: "ja",
    label: "Japanese",
    script: "japanese",
    extract: true,
    translate: true,
  },
  ko: {
    code: "ko",
    label: "Korean",
    script: "korean",
    extract: true,
    translate: false,
    // Shown wherever a Korean track is found. Step 3 of the Korean work is
    // what flips `translate` here; see eval/korean-findings.md.
    pending:
      "Korean captions can be extracted, but translating them needs a Korean " +
      "prompt that is not written yet — the Japanese one would produce poor " +
      "results.",
  },
};

/**
 * Which track to prefer when a video carries several. Japanese first because
 * it is the supported one; a video with both should translate, not stop.
 */
export const SOURCE_PRIORITY = ["ja", "ko"];

export function languageOf(code) {
  return LANGUAGES[code] || null;
}

export function canTranslate(code) {
  return !!LANGUAGES[code]?.translate;
}

export function labelOf(code) {
  return LANGUAGES[code]?.label || code || "unknown";
}

/** Pick the best source track from a list of `{lang, kind}`. */
export function pickSource(tracks = []) {
  for (const code of SOURCE_PRIORITY) {
    const found = tracks.find((t) => (t.lang || t.languageCode) === code);
    if (found) return { ...found, lang: code };
  }
  return null;
}
