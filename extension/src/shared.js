// Settings and formatting shared by the two things that run a pipeline: the
// service worker (YouTube tabs) and the subtitle-file page.
//
// This is extension-only, deliberately NOT under core/ — it touches
// chrome.storage, and core/ is also imported by the Node CLI.

export const DEFAULTS = {
  backend: "ollama",
  model: "qwen3.5:9b",
  host: "http://localhost:11434",
  size: 20,
  contextBefore: 10,
  contextAfter: 6,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

/** "1h 5m", "2m 10s", "45s" — coarse on purpose, an ETA implies less than it knows. */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
