// Subtitle files, both directions: .srt/.vtt -> cues, and units -> .srt.
//
// The parser exists so the pipeline can be pointed at a file instead of a
// YouTube tab. A cue from a file is the same shape as a cue from YouTube minus
// `segs` (word-level timings), which segment.js already treats as the normal
// half of the cases.
//
// Timings come from the units, which carry the original cue timings forward, so
// nothing here has to guess. The one real decision is what to do when a unit is
// long: subtitles are read at speed, so an over-long line gets split across two
// display lines rather than being allowed to run off the screen.

const MAX_LINE_CHARS = 42;
// Two lines is the subtitle convention, but ~6% of translations exceed what
// two lines can hold (Japanese expands 2-4x into English). Jamming the
// remainder onto line two produced an unreadable run-on, so allow a third
// line rather than mangling it. The real fix is shorter source units.
const MAX_LINES = 3;

function timestamp(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const h = String(Math.floor(clamped / 3600000)).padStart(2, "0");
  const m = String(Math.floor(clamped / 60000) % 60).padStart(2, "0");
  const s = String(Math.floor(clamped / 1000) % 60).padStart(2, "0");
  const msPart = String(clamped % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${msPart}`;
}

/** Greedy word wrap, capped at MAX_LINES. */
export function wrap(text, maxChars = MAX_LINE_CHARS, maxLines = MAX_LINES) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines.join("\n");
  // Too long to show properly: keep the cap, put the remainder on the last line.
  const kept = lines.slice(0, maxLines - 1);
  kept.push(lines.slice(maxLines - 1).join(" "));
  return kept.join("\n");
}

export function toSrt(units, translations, { minDurationMs = 700 } = {}) {
  const blocks = [];
  let n = 0;

  units.forEach((unit, i) => {
    const text = (translations[i] || "").trim();
    if (!text) return;

    const start = unit.start_ms;
    // Never let a cue vanish because the source cue had no duration.
    const end = Math.max(unit.end_ms, start + minDurationMs);

    n += 1;
    blocks.push(`${n}\n${timestamp(start)} --> ${timestamp(end)}\n${wrap(text)}`);
  });

  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

// ------------------------------------------------------------------- parsing

/**
 * A timecode line, in either dialect: SRT writes `00:01:02,500`, WebVTT writes
 * `00:01:02.500` and is allowed to drop the hour entirely (`01:02.500`).
 */
const TIMECODE =
  /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** Markup, both dialects: WebVTT `<v Name>`/`<i>`, and ASS overrides `{\an8}`. */
const MARKUP = /<[^>]*>/g;
const ASS_OVERRIDE = /\{\\[^}]*\}/g;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Japanese has no inter-word spaces, so lines wrapped by the subtitler must be
 * rejoined with nothing. Doing that unconditionally would instead run English
 * words together, so the decision is made per boundary.
 *
 * Escapes, not literal characters: these ranges are invisible in an editor and
 * a re-encode would corrupt them silently.
 */
const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/;

function toMs(hours, minutes, seconds, fraction) {
  // "5" means 500 ms, not 5 ms — the fraction is a decimal, not a count.
  const ms = Number((fraction || "0").padEnd(3, "0").slice(0, 3));
  return ((Number(hours || 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + ms;
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ENTITIES[name]);
}

function joinLines(lines) {
  return lines.reduce((acc, line) => {
    if (!acc) return line;
    const glue = CJK.test(acc.slice(-1)) && CJK.test(line.slice(0, 1)) ? "" : " ";
    return acc + glue + line;
  }, "");
}

/**
 * Rolling captions — the normal shape of an auto-generated track pulled out of
 * YouTube — repeat the previous cue's text at the top of the next one so the
 * screen appears to scroll. Left alone that is the same sentence translated
 * two or three times, at two or three times the cost, with the repetition
 * visible in the output.
 *
 * Two shapes are collapsed: an exact repeat, and a cue that OVERLAPS its
 * predecessor and begins with the whole of it. The overlap test is what keeps
 * this off genuine repetition, which does not share a timespan.
 */
function collapseRolling(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    // The overlap test guards BOTH shapes. Without it here, a word said twice
    // in a video — "はい" at 0:01 and again at 0:10 — collapsed into a single
    // ten-second subtitle and the second utterance was lost.
    const overlaps = prev && cue.t_ms < prev.t_ms + prev.dur_ms;

    if (overlaps && prev.ja === cue.ja) {
      prev.dur_ms = Math.max(prev.dur_ms, cue.t_ms + cue.dur_ms - prev.t_ms);
      continue;
    }
    if (overlaps && cue.ja.startsWith(prev.ja)) {
      const rest = cue.ja.slice(prev.ja.length).trim();
      if (!rest) continue;
      out.push({ ...cue, ja: rest });
      continue;
    }
    out.push(cue);
  }
  return out;
}

/**
 * Parse an .srt or .vtt file into the cue shape the pipeline consumes.
 *
 * Both formats are handled by one scanner rather than two parsers, because the
 * only structural difference that matters here is the decimal separator. Files
 * in the wild break the spec constantly — missing blank lines, CRLF, a BOM,
 * cue settings after the timestamp — so this looks for timecode lines and
 * treats everything between them as text, instead of trusting block structure.
 *
 * @returns {{t_ms:number, dur_ms:number, ja:string}[]}
 */
export function parseSubtitles(text) {
  const lines = String(text)
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const cues = [];

  for (let i = 0; i < lines.length; i++) {
    const stamp = TIMECODE.exec(lines[i]);
    if (!stamp) continue;

    const start = toMs(stamp[1], stamp[2], stamp[3], stamp[4]);
    const end = toMs(stamp[5], stamp[6], stamp[7], stamp[8]);

    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) break;
      if (TIMECODE.test(lines[j])) break;
      body.push(lines[j]);
    }
    // A file written without blank lines between cues leaves the next cue's
    // index number as the last line of this one's text. It is not dialogue.
    if (body.length && TIMECODE.test(lines[j] || "") && /^\d+$/.test(body.at(-1).trim())) {
      body.pop();
    }
    i = j - 1;

    const parts = body
      // Strip markup before decoding entities, so an escaped `&lt;i&gt;` in
      // the dialogue survives as text instead of turning into a tag.
      .map((line) => decodeEntities(line.replace(MARKUP, "").replace(ASS_OVERRIDE, "")).trim())
      .filter(Boolean);

    const ja = joinLines(parts).trim();
    if (!ja) continue;

    cues.push({ t_ms: start, dur_ms: Math.max(0, end - start), ja });
  }

  cues.sort((a, b) => a.t_ms - b.t_ms);
  return collapseRolling(cues);
}

/** Enough to tell the reader whether the file they picked is the right one. */
export function describeCues(cues) {
  const chars = cues.reduce((n, c) => n + c.ja.length, 0);
  const cjk = cues.reduce(
    (n, c) => n + [...c.ja].filter((ch) => CJK.test(ch)).length,
    0
  );
  const last = cues.length ? cues.at(-1).t_ms + cues.at(-1).dur_ms : 0;
  return {
    cues: cues.length,
    chars,
    durationMs: last,
    // Proportion of Japanese characters. A wrong-language file is otherwise
    // only discovered after a long and completely useless run.
    cjkRatio: chars ? cjk / chars : 0,
  };
}
