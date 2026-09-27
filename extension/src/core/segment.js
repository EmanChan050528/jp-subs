// Caption cues -> translation units.
//
// Cues are timed for reading, not for grammar. The hard part is that cue
// granularity varies enormously between videos even within kind=asr:
//
//   EmteTL5Ij8g  mean 6.6 chars/cue   scrolling fragments, break mid-clause
//   NSY6YHXbxtA  mean 16.0 chars/cue  several whole sentences per cue
//
// Neither "merge cues" nor "keep cues" is right on its own, because the two
// videos need opposite treatment. So work at sentence level instead of cue
// level: explode every cue into sentence pieces, then accumulate pieces into
// units. Fragmented cues get joined; overloaded cues get split. One pass, both
// shapes.

import { joiner } from "./script.js";

/**
 * Sentence-final punctuation, allowing trailing quotes/brackets.
 *
 * The ASCII period is in this class, and it matters more than it looks: this
 * carried the FULLWIDTH period ．(U+FF0E) but not the plain one, so Korean
 * statements — which use the plain one — never closed a unit. Measured on a
 * real Korean track that left the median subtitle on screen for 9.0 s; adding
 * one character took it to 4.4 s. Safe for Japanese: neither Japanese fixture
 * contains an ASCII period at all, and both segment identically with it.
 */
const SENTENCE_END = /[。．！？!?.]+["'」』）\)】〉》]*\s*$/;

/**
 * Split after sentence-final punctuation, keeping the punctuation.
 *
 * `(?!\d)` is the guard the end-anchored rule above does not need. This one
 * fires mid-text, so without it "3.5" would split into "3." and "5".
 */
const SENTENCE_SPLIT = /(?<=[。．！？!?.]+["'」』）\)】〉》]*)(?!\d)/u;

/** A cue that is only a bracketed tag: [音楽], [拍手], [Music]. */
const TAG_ONLY = /^[\[［][^\]］]*[\]］]$/;

/**
 * Speaker-change marker. YouTube's Korean auto-captions emit `>>` at a change
 * of speaker (53% of cues on the measured track); the Japanese track never
 * does. It is not dialogue, so it is stripped — but it is the only speaker
 * signal any track gives us, so the boundary it marks is kept on the unit.
 */
const TURN_MARKER = /^\s*(?:&gt;&gt;|>>)+\s*/;
const TURN_MARKER_ANY = /(?:&gt;&gt;|>>)+\s*/g;

export const DEFAULTS = {
  /** Silence (ms) between cues that ends a unit on its own. */
  gapMs: 2000,
  /** Never let a unit grow past this many characters. */
  maxChars: 64,
  /** Drop cues that are nothing but a [music] style tag. */
  dropTagOnlyCues: true,
};

/**
 * Expand a cue into per-character timestamps using YouTube's word-level
 * `segs`. Returns null when the cue has none, which is about half of them.
 */
function charTimes(cue) {
  if (!Array.isArray(cue.segs) || !cue.segs.length) return null;
  const chars = [];
  for (const seg of cue.segs) {
    const text = seg.text || "";
    for (const ch of text) chars.push({ ch, t_ms: seg.t_ms });
  }
  return chars.length ? chars : null;
}

/**
 * Strip `>>` speaker markers, recording where they were.
 *
 * Both the cue text and the word-level `segs` have to be cleaned, or the
 * per-character timing walk drifts out of step with the text it is timing.
 * A cue that *began* with a marker starts a new speaker turn; markers found
 * mid-cue are removed but not treated as boundaries, because the timing data
 * cannot say where inside the cue the change happened.
 */
function stripTurnMarkers(cues) {
  return cues.map((cue) => {
    const text = cue.ja || "";
    if (!TURN_MARKER_ANY.test(text)) return cue;
    TURN_MARKER_ANY.lastIndex = 0;

    const next = {
      ...cue,
      ja: text.replace(TURN_MARKER_ANY, "").trim(),
      turn: TURN_MARKER.test(text),
    };
    if (Array.isArray(cue.segs)) {
      next.segs = cue.segs.map((s) => ({ ...s, text: (s.text || "").replace(TURN_MARKER_ANY, "") }));
    }
    return next;
  });
}

/**
 * Explode cues into sentence pieces.
 *
 * Where YouTube gives word-level timings, a piece starts at the real timestamp
 * of its first character — no estimation at all. Where it does not, the start
 * is still apportioned by character count (it has to be, or several pieces
 * would share a start and only the last would ever display), but the END is
 * anchored to the cue's own end so that nothing expires before the speech in
 * that cue has finished.
 */
function toPieces(cues, dropTagOnlyCues) {
  const pieces = [];

  cues.forEach((cue, index) => {
    const cueText = (cue.ja || "").trim();
    if (!cueText) return;
    if (dropTagOnlyCues && TAG_ONLY.test(cueText)) return;

    const cueEnd = cue.t_ms + (cue.dur_ms || 0);
    const timed = charTimes(cue);

    // A cue that opened with `>>` starts a speaker turn at its first piece,
    // whichever timing path produced it.
    const before = pieces.length;
    const markTurn = () => {
      if (cue.turn && pieces.length > before) pieces[before].startsTurn = true;
    };

    if (timed) {
      // Walk the characters, closing a piece at sentence-final punctuation.
      // Every boundary lands on a timestamp YouTube actually reported.
      let buf = "";
      let startMs = null;
      const flushPiece = (endMs) => {
        const text = buf.trim();
        buf = "";
        if (!text) { startMs = null; return; }
        pieces.push({
          text,
          start_ms: startMs ?? cue.t_ms,
          end_ms: Math.max(endMs, (startMs ?? cue.t_ms) + 1),
          cue_index: index,
          endsSentence: SENTENCE_END.test(text),
        });
        startMs = null;
      };

      for (let i = 0; i < timed.length; i++) {
        if (buf === "" && timed[i].ch.trim()) startMs = timed[i].t_ms;
        buf += timed[i].ch;
        if (SENTENCE_END.test(buf)) {
          // End at the next character's timestamp, i.e. when the next word
          // actually begins; otherwise the cue's own end.
          flushPiece(i + 1 < timed.length ? timed[i + 1].t_ms : cueEnd);
        }
      }
      flushPiece(cueEnd);
      markTurn();
      return;
    }

    // No word timings: apportion starts, but anchor every end to the cue end.
    const parts = cueText.split(SENTENCE_SPLIT).map((p) => p.trim()).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    const duration = cue.dur_ms || 0;

    let offset = 0;
    for (const part of parts) {
      const start = cue.t_ms + Math.round(duration * offset);
      offset += part.length / total;
      pieces.push({
        text: part,
        start_ms: start,
        end_ms: cueEnd,
        cue_index: index,
        endsSentence: SENTENCE_END.test(part),
      });
    }

    markTurn();
  });

  return pieces;
}

/**
 * @param {{t_ms:number, dur_ms?:number, ja:string}[]} cues
 * @returns {{ja:string, start_ms:number, end_ms:number, cue_index:number[]}[]}
 */
export function segment(cues, options = {}) {
  const { gapMs, maxChars, dropTagOnlyCues } = { ...DEFAULTS, ...options };
  const pieces = toPieces(stripTurnMarkers(cues), dropTagOnlyCues);

  const units = [];
  let current = null;

  const flush = () => {
    if (current && current.ja.trim()) units.push(current);
    current = null;
  };

  for (const piece of pieces) {
    if (current) {
      const silence = piece.start_ms - current.end_ms;
      // A speaker change always ends a unit. Merging two speakers into one
      // subtitle attributes one person's words to the other, which is a worse
      // error than a short unit.
      if (piece.startsTurn || silence >= gapMs ||
          current.ja.length + piece.text.length > maxChars) {
        flush();
      }
    }

    if (!current) {
      current = {
        ja: "",
        start_ms: piece.start_ms,
        end_ms: piece.end_ms,
        cue_index: [],
        turn: !!piece.startsTurn,
      };
    }

    // Spacing is per-boundary, not unconditional. Concatenating outright is
    // correct for Japanese and welds Korean words together.
    current.ja += joiner(current.ja, piece.text) + piece.text;
    current.end_ms = Math.max(current.end_ms, piece.end_ms);
    if (!current.cue_index.includes(piece.cue_index)) {
      current.cue_index.push(piece.cue_index);
    }

    // A piece that ends a sentence ends the unit. This is the rule that makes
    // both cue shapes come out the same way.
    if (piece.endsSentence) flush();
  }

  flush();
  return units;
}

/** Descriptive stats, for checking segmentation without calling a model. */
export function stats(cues, units) {
  const cueLens = cues.map((c) => (c.ja || "").trim().length).filter(Boolean);
  const unitLens = units.map((u) => u.ja.length);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    cues: cues.length,
    units: units.length,
    mergeRatio: units.length ? +(cues.length / units.length).toFixed(2) : 0,
    cueCharsMean: +mean(cueLens).toFixed(1),
    unitCharsMean: +mean(unitLens).toFixed(1),
    unitCharsMedian: median(unitLens),
    unitCharsMax: unitLens.length ? Math.max(...unitLens) : 0,
    unitsEndingInPunctuation: units.filter((u) => SENTENCE_END.test(u.ja)).length,
  };
}
