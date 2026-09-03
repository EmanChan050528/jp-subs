// Translated units -> .srt
//
// Timings come from the units, which carry the original cue timings forward, so
// nothing here has to guess. The one real decision is what to do when a unit is
// long: subtitles are read at speed, so an over-long line gets split across two
// display lines rather than being allowed to run off the screen.

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;

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
