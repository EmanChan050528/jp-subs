// Translation units -> request chunks.
//
// Each chunk carries units the model must translate, plus surrounding units it
// may only read. The `after` window is the whole point of doing this on VOD: a
// live pipeline can never see it, and in Japanese the thing that disambiguates
// a dropped subject is very often what comes next.

export const DEFAULTS = {
  /** Units translated per request. */
  size: 20,
  /** Units of preceding context, read-only. */
  contextBefore: 10,
  /** Units of following context, read-only. */
  contextAfter: 6,
};

export function chunk(units, options = {}) {
  const { size, contextBefore, contextAfter } = { ...DEFAULTS, ...options };
  const chunks = [];

  for (let start = 0; start < units.length; start += size) {
    const end = Math.min(start + size, units.length);
    chunks.push({
      index: chunks.length,
      firstUnit: start,
      before: units.slice(Math.max(0, start - contextBefore), start),
      target: units.slice(start, end),
      after: units.slice(end, Math.min(end + contextAfter, units.length)),
    });
  }

  return chunks;
}
