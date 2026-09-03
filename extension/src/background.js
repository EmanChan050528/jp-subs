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

/** Shape the pipeline's parallel arrays into what the overlay consumes. */
function toOverlayUnits(units, translations) {
  return units
    .map((u, i) => ({ t_ms: u.start_ms, end_ms: u.end_ms, en: translations[i] || "" }))
    .filter((u) => u.en);
}

async function translateTab(tabId) {
  const config = await settings();
  const backend = makeBackend(config.backend, {
    model: config.model,
    host: config.host,
  });

  setState(tabId, { running: true, phase: "extracting", error: null, done: 0, total: 0 });
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
  const { failures } = await translateUnits(
    units, glossary, backend, config, log,
    (partial, done, total) => {
      setState(tabId, { done, total });
      // Push partial results so subtitles appear before the whole video is done.
      console.debug(`[jpsub] sending ${done}/${total}`);
      send(tabId, {
        type: "overlay:units",
        units: toOverlayUnits(units, partial),
        status: done < total ? `Translating… ${done}/${total}` : "",
      });
    }
  );

  setState(tabId, { running: false, phase: "done", failures });
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
    translateTab(tabId)
      .then((r) => sendResponse({ ok: true, data: r }))
      .catch(async (err) => {
        setState(tabId, { running: false, phase: "error", error: err.message });
        await send(tabId, { type: "overlay:status", text: `Failed: ${err.message}` });
        sendResponse({ ok: false, error: err.message });
      });
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
