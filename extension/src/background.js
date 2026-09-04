// Service worker. Runs the translation pipeline.
//
// This work lives here, not in a content script, because the model calls are
// cross-origin (localhost) and only the extension's own context has the host
// permission for them.
//
// Note on MV3 lifetime: a service worker is killed after ~30 s idle, but an
// in-flight fetch keeps it alive, and the pipeline is a continuous chain of
// fetches. A long video with a slow model could still be at risk; if runs start
// dying partway, move this into an offscreen document.

import { segment } from "./core/segment.js";
import { analyse, translateUnits } from "./core/pipeline.js";
import { makeBackend } from "./core/backends.js";

const DEFAULTS = {
  backend: "ollama",
  model: "qwen3.5:9b",
  host: "http://localhost:11434",
  size: 20,
  contextBefore: 10,
  contextAfter: 6,
};

/** Per-tab run state, polled by the popup. */
const runs = new Map();

// ------------------------------------------------------------------- cache
//
// Translating a 4-hour VOD takes ~15 minutes, so re-watching one should not
// repeat it. But chrome.storage.local is capped at 10 MB and a long VOD is
// roughly half a megabyte of units, so this is deliberately NOT unbounded:
// it holds a byte budget and evicts least-recently-used entries. Without that
// the cache would simply start failing writes after ~20 long videos.

const CACHE_PREFIX = "cache:";
const CACHE_INDEX = "cacheIndex";
const CACHE_BUDGET_BYTES = 7 * 1024 * 1024; // headroom under the 10 MB quota

async function readIndex() {
  return (await chrome.storage.local.get(CACHE_INDEX))[CACHE_INDEX] || {};
}

async function writeIndex(index) {
  await chrome.storage.local.set({ [CACHE_INDEX]: index });
}

async function cacheGet(videoId) {
  if (!videoId) return null;
  const key = CACHE_PREFIX + videoId;
  const entry = (await chrome.storage.local.get(key))[key];
  if (!entry) return null;

  // Touch it so eviction sees recent use, not just recent writes.
  const index = await readIndex();
  if (index[videoId]) {
    index[videoId].at = Date.now();
    await writeIndex(index);
  }
  return entry;
}

async function cachePut(videoId, entry) {
  if (!videoId) return;
  const key = CACHE_PREFIX + videoId;
  const index = await readIndex();
  index[videoId] = {
    bytes: JSON.stringify(entry).length,
    at: Date.now(),
    title: entry.title || null,
    model: entry.model || null,
    units: entry.units.length,
  };
  try {
    await chrome.storage.local.set({ [key]: entry });
    await writeIndex(index);
    await evict();
  } catch (err) {
    // A failed cache write must never fail the run — the subtitles are
    // already on screen by this point.
    console.warn("[jpsub] could not cache:", err?.message || err);
  }
}

async function evict() {
  const index = await readIndex();
  let total = Object.values(index).reduce((n, e) => n + (e.bytes || 0), 0);
  if (total <= CACHE_BUDGET_BYTES) return;

  const byAge = Object.entries(index).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  const drop = [];
  for (const [videoId, meta] of byAge) {
    if (total <= CACHE_BUDGET_BYTES) break;
    drop.push(CACHE_PREFIX + videoId);
    total -= meta.bytes || 0;
    delete index[videoId];
  }
  if (drop.length) {
    await chrome.storage.local.remove(drop);
    await writeIndex(index);
    console.debug(`[jpsub] evicted ${drop.length} cached video(s)`);
  }
}

async function cacheStats() {
  const index = await readIndex();
  const entries = Object.values(index);
  return {
    videos: entries.length,
    bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0),
    budget: CACHE_BUDGET_BYTES,
  };
}

async function cacheClear() {
  const index = await readIndex();
  const keys = Object.keys(index).map((v) => CACHE_PREFIX + v);
  await chrome.storage.local.remove([...keys, CACHE_INDEX]);
}

function setState(tabId, patch) {
  const prev = runs.get(tabId) || {};
  const next = { ...prev, ...patch };
  runs.set(tabId, next);
  return next;
}

async function settings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

function send(tabId, message) {
  // Swallowing these hid a whole class of failure: the pipeline reports
  // success while nothing ever reaches the page.
  return chrome.tabs.sendMessage(tabId, message).catch((err) => {
    console.warn(`[jpsub] could not deliver ${message.type} to tab ${tabId}:`, err?.message || err);
    setState(tabId, { deliveryError: `${message.type}: ${err?.message || err}` });
  });
}

/** "1h 5m", "2m 10s", "45s" — coarse on purpose, an ETA implies less than it knows. */
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** Shape the pipeline's parallel arrays into what the overlay consumes. */
function toOverlayUnits(units, translations) {
  return units
    .map((u, i) => ({ t_ms: u.start_ms, end_ms: u.end_ms, en: translations[i] || "" }))
    .filter((u) => u.en);
}

async function translateTab(tabId, { force = false } = {}) {
  const config = await settings();
  const backend = makeBackend(config.backend, {
    model: config.model,
    host: config.host,
  });

  setState(tabId, { running: true, phase: "extracting", error: null, done: 0, total: 0 });

  // Check the cache before extracting anything: a hit should cost no work at
  // all, not just no model calls.
  if (!force) {
    const info = await chrome.tabs.sendMessage(tabId, { type: "detect" }).catch(() => null);
    const videoId = info?.ok ? info.data.videoId : null;
    const hit = await cacheGet(videoId);
    if (hit) {
      await send(tabId, { type: "overlay:units", units: hit.units, status: "" });
      setState(tabId, {
        running: false, phase: "done", failures: [], eta: null,
        videoId, units: hit.units.length, fromCache: true, cachedModel: hit.model,
      });
      return { units: hit.units.length, failures: [], fromCache: true };
    }
  }

  await send(tabId, { type: "overlay:status", text: "Getting transcript…" });

  const extracted = await chrome.tabs.sendMessage(tabId, { type: "extract" });
  if (!extracted?.ok) throw new Error(extracted?.error || "Could not extract the transcript.");

  const transcript = extracted.data;
  const units = segment(transcript.cues);
  setState(tabId, { phase: "analysing", videoId: transcript.video_id, units: units.length });
  await send(tabId, {
    type: "overlay:status",
    text: `Reading ${units.length} lines…`,
  });

  const log = (m) => setState(tabId, { message: m });
  const glossary = await analyse(units, backend, transcript, log);

  setState(tabId, { phase: "translating" });
  const startedAt = Date.now();

  const { failures, translations: translationsOut } = await translateUnits(
    units, glossary, backend, config, log,
    (partial, done, total) => {
      // Chunks vary in length, so estimate from the mean so far rather than
      // the last one. Long videos are exactly where an ETA earns its place.
      const elapsed = Date.now() - startedAt;
      const remaining = done > 0 ? (elapsed / done) * (total - done) : null;
      const eta = remaining === null ? null : formatDuration(remaining);

      setState(tabId, { done, total, eta });
      console.debug(`[jpsub] sending ${done}/${total}${eta ? `, ~${eta} left` : ""}`);

      // Push partial results so subtitles appear before the whole video is done.
      send(tabId, {
        type: "overlay:units",
        units: toOverlayUnits(units, partial),
        status: done < total
          ? `Translating ${done}/${total}${eta ? ` · ~${eta} left` : ""}`
          : "",
      });
    }
  );

  const overlayUnits = toOverlayUnits(units, translationsOut);
  await cachePut(transcript.video_id, {
    video_id: transcript.video_id,
    title: transcript.title,
    model: config.model,
    at: Date.now(),
    units: overlayUnits,
  });

  setState(tabId, {
    running: false, phase: "done", failures, eta: null,
    fromCache: false, tookMs: Date.now() - startedAt,
  });
  await send(tabId, { type: "overlay:status", text: "" });
  return { units: units.length, failures };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "run:start") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (runs.get(tabId)?.running) {
      sendResponse({ ok: false, error: "Already running on this tab." });
      return false;
    }
    translateTab(tabId, { force: !!msg.force })
      .then((r) => sendResponse({ ok: true, data: r }))
      .catch(async (err) => {
        setState(tabId, { running: false, phase: "error", error: err.message });
        await send(tabId, { type: "overlay:status", text: `Failed: ${err.message}` });
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async
  }

  if (msg?.type === "cache:stats") {
    cacheStats().then((data) => sendResponse({ ok: true, data }));
    return true; // async
  }

  if (msg?.type === "cache:clear") {
    cacheClear().then(() => sendResponse({ ok: true }));
    return true; // async
  }

  if (msg?.type === "models:list") {
    settings()
      .then(async (config) => {
        const res = await fetch(`${config.host}/api/tags`);
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
        const data = await res.json();
        const names = (data.models || []).map((m) => m.name).sort();
        sendResponse({ ok: true, data: { models: names, selected: config.model } });
      })
      .catch((err) =>
        sendResponse({ ok: false, error: `Could not list models: ${err.message}` })
      );
    return true; // async
  }

  if (msg?.type === "run:status") {
    sendResponse({ ok: true, data: runs.get(msg.tabId) || null });
    return false;
  }

  if (msg?.type === "run:clear") {
    // The content script cannot know its own tab id, so fall back to the
    // sender. Deleting runs.get(undefined) silently did nothing, which left a
    // finished run's state alive across a navigation to a different video.
    const tabId = msg.tabId ?? sender.tab?.id;
    runs.delete(tabId);
    if (tabId !== undefined) send(tabId, { type: "overlay:clear" });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => runs.delete(tabId));
