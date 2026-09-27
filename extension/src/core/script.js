// Writing-system predicates.
//
// These were one regex called CJK, used to answer two questions that happened
// to have the same answer for Japanese:
//
//   1. "Do I need a space when joining these two pieces?"
//   2. "Is this file in the source language I expect?"
//
// Korean separates them. Hangul is a source script we want to accept, but it
// is written WITH spaces — so a single class gets one of the two answers wrong
// whichever way it is defined. Hence two predicates with two names.

/**
 * Scripts written without spaces between words: Han, kana, and the CJK
 * punctuation and fullwidth forms that travel with them. Joining two pieces of
 * this is a plain concatenation; inserting a space corrupts the text.
 *
 * Hangul is deliberately NOT here. Korean uses spaces.
 */
export const NO_SPACE_SCRIPT =
  /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/** Hangul: modern syllables, plus conjoining and compatibility jamo. */
export const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

/** Kana and Han — what "looks Japanese" means for a file-language check. */
export const JAPANESE =
  /[぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * The separator to use when joining two adjacent pieces of text.
 *
 * A space goes in only when NEITHER side is no-space script — not when both
 * sides fail to be, which is the version that looks right and is not.
 *
 * Japanese embeds ASCII freely and without spaces: 「もう1回」, 「YouTubeで」,
 * 「Aチーム」. Requiring *both* sides to be kana or Han before joining tightly
 * puts a space inside all three. Measured: nine units across the two Japanese
 * fixtures changed before this was turned around. One side being no-space
 * script is enough to mean "these languages do not want a space here".
 */
export function joiner(left, right) {
  if (!left || !right) return "";
  const a = left.slice(-1);
  const b = right.slice(0, 1);
  if (/\s/.test(a) || /\s/.test(b)) return "";
  return NO_SPACE_SCRIPT.test(a) || NO_SPACE_SCRIPT.test(b) ? "" : " ";
}

/** Join pieces with per-boundary spacing. */
export function joinPieces(pieces) {
  return pieces.reduce((acc, piece) => (acc ? acc + joiner(acc, piece) + piece : piece), "");
}

/**
 * Which source script a body of text is written in, and how strongly.
 *
 * Returns the dominant script rather than a single ratio, because "is this
 * Japanese?" and "is this a language we support?" stopped being the same
 * question. `ratio` is the share of characters belonging to `script`.
 */
export function detectScript(text) {
  let ja = 0;
  let ko = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    if (JAPANESE.test(ch)) ja += 1;
    else if (HANGUL.test(ch)) ko += 1;
  }
  if (!total) return { script: "unknown", ratio: 0, japanese: 0, korean: 0 };
  const jaR = ja / total;
  const koR = ko / total;
  if (jaR < 0.1 && koR < 0.1) return { script: "other", ratio: 0, japanese: jaR, korean: koR };
  return {
    script: jaR >= koR ? "japanese" : "korean",
    ratio: Math.max(jaR, koR),
    japanese: jaR,
    korean: koR,
  };
}
