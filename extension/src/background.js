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
import { toSrt } from "./core/srt.js";

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

/**
 * Bump whenever segmentation or timing changes shape. A cache entry stores the
 * timings it was built with, so without this an old entry keeps serving them
 * forever and an algorithm fix silently never reaches videos already watched.
 *
 * 2 — sentence splits anchored to YouTube's word-level timings.
 */
const PIPELINE_VERSION = 2;
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

  // Built by an older pipeline: drop it rather than serve stale timings.
  if ((entry.pipeline || 1) !== PIPELINE_VERSION) {
    console.debug(`[jpsub] cache entry for ${videoId} is stale (v${entry.pipeline || 1}); discarding`);
    const index = await readIndex();
    delete index[videoId];
    await chrome.storage.local.remove(key);
    await writeIndex(index);
    return null;
  }

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

// --------------------------------------------------------- channel glossary
//
// Names and recurring vocabulary are properties of a channel, not of a single
// video, so they are accumulated per channel and fed into pass 1 of the next
// video from the same one. This is what stops a streamer being romanised
// differently every time, and it compounds with the cache: channels repeat.

const CHANNEL_PREFIX = "chan:";
const CHANNEL_MAX_ENTRIES = 40;   // per category; keeps the prompt small

async function channelGlossary(channelId) {
  if (!channelId) return null;
  const key = CHANNEL_PREFIX + channelId;
  return (await chrome.storage.local.get(key))[key] || null;
}

/** Channels remembered. Each glossary is small, but the count was unbounded. */
const CHANNEL_MAX_CHANNELS = 200;

async function pruneChannels() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CHANNEL_PREFIX));
  if (keys.length <= CHANNEL_MAX_CHANNELS) return;
  // Hand-edited glossaries are kept regardless: they cost a person's effort.
  const droppable = keys
    .filter((k) => !all[k]?.editedByHand)
    .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0));
  const drop = droppable.slice(0, keys.length - CHANNEL_MAX_CHANNELS);
  if (drop.length) await chrome.storage.local.remove(drop);
}

/** Merge this video's findings into the channel's running glossary. */
async function rememberChannelGlossary(channelId, glossary, author) {
  if (!channelId || !glossary) return;
  const key = CHANNEL_PREFIX + channelId;
  const prev = (await chrome.storage.local.get(key))[key] || { names: {}, terms: {} };

  // Existing entries win: a spelling already used in earlier subtitles should
  // not drift because one video's analysis phrased it differently.
  const merge = (base, add) => {
    const out = { ...(add || {}), ...(base || {}) };
    return Object.fromEntries(Object.entries(out).slice(0, CHANNEL_MAX_ENTRIES));
  };

  const next = {
    author: author || prev.author || null,
    names: merge(prev.names, glossary.names),
    terms: merge(prev.terms, glossary.terms),
    videos: (prev.videos || 0) + 1,
    at: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [key]: next });
    await pruneChannels();
  } catch (err) {
    console.warn("[jpsub] could not save channel glossary:", err?.message || err);
  }
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

/**
 * Finish an abandoned run. A partial translation is deliberately NOT cached —
 * it would look complete on the next visit with no way to tell.
 */
async function stopRun(tabId, videoId, unitCount, translatedSoFar) {
  inFlight.delete(tabId);
  setState(tabId, {
    running: false, phase: "cancelled", eta: null, stopping: false,
    translatedSoFar,
  });
  cancelled.delete(tabId);
  await send(tabId, { type: "overlay:status", videoId, text: "" });
  return { units: unitCount, failures: [], stopped: true };
}

/** Shape the pipeline's parallel arrays into what the overlay consumes. */
function toOverlayUnits(units, translations) {
  return units
    .map((u, i) => ({ t_ms: u.start_ms, end_ms: u.end_ms, en: translations[i] || "" }))
    .filter((u) => u.en);
}

/** Tabs whose in-flight run has been abandoned (the viewer navigated away). */
const cancelled = new Set();

/**
 * Aborts the request currently in flight for a tab.
 *
 * Without this, Stop only landed between chunks — and during pass 1, which is a
 * single long request, it did not land at all until that request returned.
 */
const inFlight = new Map();

async function translateTab(tabId, { force = false } = {}) {
  // Clear any leftover flag from a previous run before the first await. Doing
  // this later wiped out a stop pressed while the transcript was being
  // fetched.
  cancelled.delete(tabId);
  inFlight.get(tabId)?.abort();

  const controller = new AbortController();
  inFlight.set(tabId, controller);

  const config = await settings();
  const backend = makeBackend(config.backend, {
    model: config.model,
    host: config.host,
    signal: controller.signal,
  });

  setState(tabId, { running: true, phase: "extracting", error: null, done: 0, total: 0 });

  // Check the cache before extracting anything: a hit should cost no work at
  // all, not just no model calls.
  if (!force) {
    const info = await chrome.tabs.sendMessage(tabId, { type: "detect" }).catch(() => null);
    const videoId = info?.ok ? info.data.videoId : null;
    const hit = await cacheGet(videoId);
    if (hit) {
      await send(tabId, { type: "overlay:units", videoId, units: hit.units, status: "" });
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
  const runVideoId = transcript.video_id;
  const units = segment(transcript.cues);
  setState(tabId, {
    phase: "analysing", videoId: transcript.video_id, units: units.length,
    analysingSince: Date.now(),
  });
  await send(tabId, {
    type: "overlay:status",
    text: `Reading ${units.length} lines…`,
  });

  const log = (m) => setState(tabId, { message: m });
  const seed = await channelGlossary(transcript.channel_id);
  if (seed) {
    log(`carrying ${Object.keys(seed.names || {}).length} names forward from ${seed.author || "this channel"}`);
  }
  if (cancelled.has(tabId)) return stopRun(tabId, runVideoId, units.length, 0);

  const glossary = await analyse(units, backend, transcript, log, seed);
  await rememberChannelGlossary(transcript.channel_id, glossary, transcript.author);

  // Pass 1 is a single request with no chunk boundary to check at, so a stop
  // pressed during it only lands here — up to ~30 s on a long video.
  if (cancelled.has(tabId)) return stopRun(tabId, runVideoId, units.length, 0);

  // Announce pass 2 before the first chunk, not after it. Nothing was sent
  // between pass 1 finishing and chunk 1 completing, so the video sat on
  // "Reading N lines…" for the whole first chunk — minutes, on a slow machine.
  const chunkCount = Math.max(1, Math.ceil(units.length / (Number(config.size) || 20)));
  setState(tabId, { phase: "translating", done: 0, total: chunkCount, eta: null });
  await send(tabId, {
    type: "overlay:status",
    videoId: runVideoId,
    text: `Translating 0/${chunkCount}…`,
  });

  const startedAt = Date.now();

  const { failures, translations: translationsOut, stopped } = await translateUnits(
    units, glossary, backend,
    { ...config, shouldStop: () => cancelled.has(tabId) },
    log,
    (partial, done, total) => {
      // Chunks vary in length, so estimate from the mean so far rather than
      // the last one. Long videos are exactly where an ETA earns its place.
      const elapsed = Date.now() - startedAt;
      const remaining = done > 0 ? (elapsed / done) * (total - done) : null;
      const eta = remaining === null ? null : formatDuration(remaining);

      setState(tabId, { done, total, eta });
      console.debug(`[jpsub] sending ${done}/${total}${eta ? `, ~${eta} left` : ""}`);

      // Push partial results so subtitles appear before the whole video is done.
      // Stamped with the video id so a stale run cannot paint its subtitles
      // onto whatever the tab moved on to.
      send(tabId, {
        type: "overlay:units",
        videoId: runVideoId,
        units: toOverlayUnits(units, partial),
        status: done < total
          ? `Translating ${done}/${total}${eta ? ` · ~${eta} left` : ""}`
          : "",
      });
    }
  );

  if (stopped) {
    return stopRun(tabId, runVideoId, units.length, translationsOut.filter(Boolean).length);
  }

  const overlayUnits = toOverlayUnits(units, translationsOut);
  await cachePut(transcript.video_id, {
    video_id: transcript.video_id,
    title: transcript.title,
    model: config.model,
    channel_id: transcript.channel_id || null,
    pipeline: PIPELINE_VERSION,
    at: Date.now(),
    units: overlayUnits,
  });

  setState(tabId, {
    running: false, phase: "done", failures, eta: null,
    fromCache: false, tookMs: Date.now() - startedAt,
  });
  await send(tabId, { type: "overlay:status", videoId: runVideoId, text: "" });
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
        if (cancelled.has(tabId) || /^Stopped\.$/.test(err.message || "")) {
          cancelled.delete(tabId);
          inFlight.delete(tabId);
          setState(tabId, { running: false, phase: "cancelled", stopping: false, eta: null });
          await send(tabId, { type: "overlay:status", text: "" });
          sendResponse({ ok: true, data: { stopped: true } });
          return;
        }
        setState(tabId, { running: false, phase: "error", error: err.message });
        await send(tabId, { type: "overlay:status", text: `Failed: ${err.message}` });
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async
  }

  if (msg?.type === "glossary:apply") {
    // Rewrite an already-cached translation in place, so correcting a name
    // does not cost another full run.
    //
    // This works on the ENGLISH text, because that is all a cached entry
    // holds. The Japanese-to-English glossary cannot be applied backwards; what
    // makes it possible is that an *edit* carries both the old and new English,
    // so the change is a plain substitution.
    (async () => {
      const entry = await cacheGet(msg.videoId);
      if (!entry) throw new Error("Nothing cached for this video.");

      let changed = 0;
      const units = entry.units.map((u) => {
        let en = u.en;
        for (const { from, to } of msg.replacements || []) {
          if (!from || !to || from === to) continue;
          // Word boundaries so "Frea" does not also rewrite "Freak". Only
          // usable when the old value starts and ends with a word character;
          // otherwise fall back to a literal match.
          const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const wordish = /^\w/.test(from) && /\w$/.test(from);
          const re = new RegExp(wordish ? `\\b${esc}\\b` : esc, "g");
          if (re.test(en)) { en = en.replace(re, to); }
        }
        if (en !== u.en) changed++;
        return { ...u, en };
      });

      if (changed) {
        await cachePut(msg.videoId, { ...entry, units, at: Date.now() });
        const tabId = msg.tabId ?? sender.tab?.id;
        await send(tabId, { type: "overlay:units", videoId: msg.videoId, units, status: "" });
      }
      return { changed, total: entry.units.length };
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (msg?.type === "cache:has") {
    // The popup asks this instead of trusting run state: `runs` is an
    // in-memory Map and the MV3 worker is killed after ~30 s idle, so after a
    // short pause it reports nothing for a video that is plainly translated.
    cacheGet(msg.videoId)
      .then((e) => sendResponse({ ok: true, data: e && {
        lines: e.units.length, model: e.model, title: e.title, at: e.at,
      } }))
      .catch(() => sendResponse({ ok: true, data: null }));
    return true; // async
  }

  if (msg?.type === "subs:apply") {
    // Re-show a cached translation without re-running anything — after a page
    // reload, or after the subtitles were hidden.
    const tabId = msg.tabId ?? sender.tab?.id;
    cacheGet(msg.videoId)
      .then(async (e) => {
        if (!e) return sendResponse({ ok: false, error: "Nothing cached for this video." });
        await send(tabId, { type: "overlay:units", videoId: msg.videoId, units: e.units, status: "" });
        sendResponse({ ok: true, data: { lines: e.units.length } });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (msg?.type === "srt:get") {
    // Built here rather than in the content script: srt.js is an ES module and
    // content scripts cannot import one.
    cacheGet(msg.videoId)
      .then((entry) => {
        if (!entry) {
          sendResponse({ ok: false, error: "Nothing cached for this video. Translate it first." });
          return;
        }
        const units = entry.units.map((u) => ({ start_ms: u.t_ms, end_ms: u.end_ms }));
        sendResponse({
          ok: true,
          data: {
            srt: toSrt(units, entry.units.map((u) => u.en)),
            title: entry.title,
            videoId: entry.video_id,
            lines: entry.units.length,
          },
        });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
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

  if (msg?.type === "channel:get") {
    channelGlossary(msg.channelId)
      .then((g) => sendResponse({ ok: true, data: g || { names: {}, terms: {} } }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (msg?.type === "channel:save") {
    (async () => {
      if (!msg.channelId) throw new Error("No channel for this page.");
      const key = "chan:" + msg.channelId;
      const prev = (await chrome.storage.local.get(key))[key] || {};
      // Written wholesale: what the editor shows is exactly what is stored, so
      // removing a line removes the entry.
      await chrome.storage.local.set({
        [key]: {
          ...prev,
          author: msg.author || prev.author || null,
          names: msg.names || {},
          terms: msg.terms || {},
          at: Date.now(),
          editedByHand: true,
        },
      });
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (msg?.type === "channel:info") {
    channelGlossary(msg.channelId)
      .then((g) => sendResponse({ ok: true, data: g && {
        author: g.author, videos: g.videos,
        names: Object.keys(g.names || {}).length,
        terms: Object.keys(g.terms || {}).length,
      } }))
      .catch(() => sendResponse({ ok: true, data: null }));
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

  if (msg?.type === "run:stop") {
    // The run loop checks this between chunks, so stopping takes effect within
    // one chunk rather than instantly. Subtitles already delivered stay put —
    // they are correct for the part that was translated.
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId !== undefined) {
      cancelled.add(tabId);
      // Abort the request in flight too, so a stop during pass 1 is immediate
      // instead of waiting out a request that may run for minutes.
      inFlight.get(tabId)?.abort();
      setState(tabId, { stopping: true });
      send(tabId, { type: "overlay:status", text: "Stopping…" });
    }
    sendResponse({ ok: true });
    return false;
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
    // Abandon any run for this tab. Without this the old video's run kept
    // going, kept the tab marked busy so the new video could not be
    // translated, and kept pushing its subtitles onto the new video.
    if (tabId !== undefined) cancelled.add(tabId);
    runs.delete(tabId);
    if (tabId !== undefined) send(tabId, { type: "overlay:clear" });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => runs.delete(tabId));
