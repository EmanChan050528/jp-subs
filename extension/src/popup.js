"use strict";

const $ = (id) => document.getElementById(id);
const goButton = $("go");
const againButton = $("again");
const stopButton = $("stop");
const saveButton = $("save");
const srtButton = $("srt");
const visButton = $("visToggle");

/**
 * Every async button does the same three things: say it is working, do it, put
 * itself back. Without this a click on a slow action looks like nothing
 * happened.
 */
async function withFeedback(button, busyLabel, fn) {
  const label = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add("busy");
  if (busyLabel) button.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    button.classList.remove("busy");
    button.textContent = label;
    button.disabled = wasDisabled;
  }
}

const bar = $("bar");

let tabId = null;
let poll = null;
let currentVideoId = null;
let cachedHere = null;      // cache entry meta for the video on screen
let subsHidden = false;
const GO_LABEL = "Translate & show subtitles";

/**
 * Whether this video already has a translation.
 *
 * Asked of the cache, not of the worker's run map: `runs` is in-memory and the
 * MV3 worker is killed after ~30 s idle, so reopening the popup after a pause
 * reported nothing and left the buttons in their default state.
 */
function isDoneForThisVideo(state) {
  if (cachedHere) return true;
  return !!state
    && state.phase === "done"
    && !!currentVideoId
    && state.videoId === currentVideoId;
}

function show(text, kind) {
  const el = $("msg");
  el.textContent = text;
  el.className = text ? `show ${kind}` : "";
}

function facts(rows) {
  $("facts").innerHTML = "";
  for (const [label, value, cls] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (cls) dd.className = cls;
    $("facts").append(dt, dd);
  }
}

function setProgress(done, total) {
  if (!total) { bar.removeAttribute("value"); bar.removeAttribute("max"); return; }
  bar.max = total;
  bar.value = done;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function toTab(type) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    return {
      ok: false,
      error:
        "Could not reach the page. Open a YouTube watch page and reload it — " +
        "the extension only attaches on a fresh page load.",
    };
  }
}

// ------------------------------------------------------------------ settings

async function loadSettings() {
  const s = await chrome.storage.local.get(["host"]);
  $("host").value = s.host || "";
}

/**
 * The model list comes from the worker, not from here: only the extension's
 * own context holds the localhost host permission.
 *
 * Worth offering because model choice is the only real speed lever. Chunk size
 * and context width were measured making almost no difference (14.8 s vs
 * 14.0 s) — the cost is generating output tokens, which chunking does not
 * change.
 */
async function loadModels() {
  const select = $("model");
  const res = await chrome.runtime.sendMessage({ type: "models:list" });

  if (!res?.ok) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(could not reach Ollama)";
    select.append(opt);
    $("modelNote").textContent = res?.error || "Ollama unreachable.";
    return;
  }

  const { models, selected } = res.data;
  select.innerHTML = "";
  if (!models.length) {
    const opt = document.createElement("option");
    opt.textContent = "(no models installed)";
    select.append(opt);
    $("modelNote").textContent = "Pull one first, e.g. ollama pull qwen3.5:9b";
    return;
  }

  for (const name of models) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    select.append(opt);
  }

  // The stored model may have been removed since it was chosen.
  if (!models.includes(selected)) {
    $("modelNote").textContent = `"${selected}" is not installed; pick another.`;
  } else {
    $("modelNote").textContent = "Smaller models are faster and less accurate.";
  }
}

$("model").addEventListener("change", async (e) => {
  const value = e.target.value.trim();
  if (value) await chrome.storage.local.set({ model: value });
});

// ---------------------------------------------------------- channel glossary
//
// Seeding makes names *consistent* across a channel, not necessarily *correct*
// — whatever the first video decided gets propagated. Editing is how a wrong
// call gets corrected once instead of recurring on every video.

let currentChannel = null;
// What the glossary held when the editor was populated. The difference between
// this and what gets saved is the only thing that can be applied to already
// translated subtitles: it carries the OLD English as well as the new.
let glossaryBefore = { names: {}, terms: {} };

/** "japanese = english" per line. Removing a line removes the entry. */
function parseGlossary(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function formatGlossary(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");
}

async function loadGlossary() {
  if (!currentChannel?.id) return;
  const res = await chrome.runtime.sendMessage({
    type: "channel:get",
    channelId: currentChannel.id,
  });
  if (!res?.ok) return;

  glossaryBefore = { names: res.data.names || {}, terms: res.data.terms || {} };
  $("gNames").value = formatGlossary(res.data.names);
  $("gTerms").value = formatGlossary(res.data.terms);
  $("glossaryWho").textContent =
    (currentChannel.author || "This channel") +
    (res.data.videos ? ` · learned from ${res.data.videos} video(s)` : " · nothing learned yet");
  $("glossaryBox").hidden = false;
}

$("saveGlossary").addEventListener("click", () =>
  withFeedback($("saveGlossary"), "Saving…", async () => {
    const res = await chrome.runtime.sendMessage({
      type: "channel:save",
      channelId: currentChannel?.id,
      author: currentChannel?.author,
      names: parseGlossary($("gNames").value),
      terms: parseGlossary($("gTerms").value),
    });
    if (!res?.ok) {
      $("glossaryNote").textContent = res?.error || "Could not save.";
      return;
    }

    const names = parseGlossary($("gNames").value);
    const terms = parseGlossary($("gTerms").value);

    // Only a CHANGED value can be applied to existing subtitles: it tells us
    // what the old English was. A newly added entry has nothing to search for,
    // because we never learn how the model rendered that term.
    const replacements = [];
    for (const [group, before] of [[names, glossaryBefore.names], [terms, glossaryBefore.terms]]) {
      for (const [ja, to] of Object.entries(group)) {
        const from = before?.[ja];
        if (from && from !== to) replacements.push({ from, to });
      }
    }
    glossaryBefore = { names, terms };

    let note = "Saved. Kept permanently, and unaffected by clearing the cache.";
    if (replacements.length && cachedHere) {
      const applied = await chrome.runtime.sendMessage({
        type: "glossary:apply", tabId, videoId: currentVideoId, replacements,
      });
      note += applied?.ok
        ? ` Updated ${applied.data.changed} line(s) in this video without re-translating.`
        : " Could not update the existing subtitles.";
      if (applied?.ok && applied.data.changed === 0) {
        note = "Saved, but nothing in this video's subtitles matched the old wording. " +
               "Use Re-translate to apply it properly.";
      }
    } else if (replacements.length) {
      note += " Applies to the next translation on this channel.";
    } else {
      note += " New entries apply to the next translation — use Re-translate to redo this one.";
    }
    $("glossaryNote").textContent = note;
  }));

async function refreshCache() {
  const res = await chrome.runtime.sendMessage({ type: "cache:stats" });
  const el = $("cacheNote");
  if (!res?.ok) { el.textContent = "unavailable"; return; }
  const { videos, bytes, budget } = res.data;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  el.textContent = videos
    ? `${videos} video${videos === 1 ? "" : "s"}, ${mb(bytes)} of ${mb(budget)} MB. Oldest are dropped when full.`
    : "empty";
}

$("clearCache").addEventListener("click", () =>
  withFeedback($("clearCache"), "Clearing…", async () => {
    await chrome.runtime.sendMessage({ type: "cache:clear" });
    await refreshCache();
    cachedHere = null;
    await refreshRunState();
    show("Cache cleared. Channel glossaries are kept.", "ok");
  }));

$("host").addEventListener("change", async (e) => {
  const value = e.target.value.trim();
  if (value) await chrome.storage.local.set({ host: value });
  else await chrome.storage.local.remove("host");
  await loadModels();
});

// -------------------------------------------------------------------- status

function stopPolling() {
  if (poll) clearInterval(poll);
  poll = null;
}

/**
 * Pass 1 is one long request with no progress of its own. Without an elapsed
 * count it looks identical to a hang — which is exactly what it was taken for
 * on a slower machine.
 */
const SLOW_HINT_MS = 120000;

function analysingText(since) {
  let text = "Reading the whole transcript…";
  if (!since) return text;
  text += `\n${Math.round((Date.now() - since) / 1000)}s so far`;
  if (Date.now() - since > SLOW_HINT_MS) {
    text +=
      "\nStill working. A large model on a slow machine can take several " +
      "minutes here — try a smaller one in Settings.";
  }
  return text;
}

async function refreshRunState() {
  const res = await chrome.runtime.sendMessage({ type: "run:status", tabId });
  const state = res?.data || {};   // the worker may have been restarted

  if (state.running) {
    goButton.disabled = true;
    saveButton.disabled = true;
    // Stopping takes effect at the next chunk boundary, so say so rather than
    // leaving the button looking unresponsive for a few seconds.
    stopButton.hidden = false;
    stopButton.disabled = !!state.stopping;
    stopButton.textContent = state.stopping ? "Stopping…" : "Stop translating";
    setProgress(state.done || 0, state.total || 0);
    const phase =
      state.phase === "translating" && state.total
        ? `Translating chunk ${state.done}/${state.total}` +
          (state.eta ? `\n~${state.eta} remaining` : "")
        : state.phase === "analysing"
          // One long request with no progress of its own. Without an elapsed
          // count this looks identical to a hang, which is exactly what it was
          // mistaken for on a slower machine.
          ? analysingText(state.analysingSince)
          : "Getting transcript…";
    show(phase, "ok");
    return;
  }

  stopPolling();
  setProgress(0, 0);
  bar.removeAttribute("value");
  saveButton.disabled = false;
  stopButton.hidden = true;

  // Offered whenever a translation exists for this video, however it got here
  // — a fresh run, a cache hit, or a worker that has since been restarted.
  const done = isDoneForThisVideo(state);
  srtButton.hidden = !done;
  visButton.hidden = !done;

  if (isDoneForThisVideo(state)) {
    // Nothing is gained by running it again on the same video, and a second
    // run would burn several minutes of local inference. Offer it explicitly
    // rather than leaving the primary button armed.
    goButton.disabled = true;
    goButton.textContent = "Subtitles applied";
    againButton.hidden = false;
  } else {
    goButton.disabled = false;
    goButton.textContent = GO_LABEL;
    againButton.hidden = true;
  }

  if (state.phase === "cancelled") {
    show(
      `Stopped${state.translatedSoFar ? ` after ${state.translatedSoFar} lines` : ""}.` +
      `
What was translated is still on screen, but nothing was saved.`,
      "ok"
    );
  } else if (state.phase === "error") show(state.error, "err");
  else if (state.phase === "done") {
    const failed = state.failures?.length;
    show(
      state.fromCache
        ? `Loaded from cache — ${state.units} lines` +
          (state.cachedModel ? ` (${state.cachedModel})` : "")
        : `Done — ${state.units} lines.` +
          (failed ? `\n${failed} chunk problem(s); some lines may be blank.` : ""),
      failed && !state.fromCache ? "err" : "ok"
    );
  }
}

// --------------------------------------------------------------------- setup

async function init() {
  await loadSettings();
  loadModels();   // not awaited: never let a slow Ollama hold up the UI
  refreshCache();

  const tab = await activeTab();
  tabId = tab?.id;

  if (!tab?.url?.includes("youtube.com")) {
    facts([["Status", "Not a YouTube page"]]);
    return;
  }

  const res = await toTab("detect");
  if (!res.ok) {
    facts([["Status", "Unavailable"]]);
    show(res.error, "err");
    return;
  }

  const d = res.data;
  if (!d.onWatchPage) {
    facts([["Status", "Not a video page"]]);
    return;
  }

  currentVideoId = d.videoId || null;
  currentChannel = d.channelId ? { id: d.channelId, author: d.author } : null;

  // Read the durable facts before painting any button, so the popup looks the
  // same on the tenth open as on the first.
  const [cacheRes, prefs] = await Promise.all([
    chrome.runtime.sendMessage({ type: "cache:has", videoId: currentVideoId }),
    chrome.storage.local.get("subtitlesHidden"),
  ]);
  cachedHere = cacheRes?.ok ? cacheRes.data : null;
  subsHidden = !!prefs.subtitlesHidden;
  $("title").textContent = d.title || d.videoId || "";
  loadGlossary();

  const rows = [
    ["Duration", d.durationSeconds ? `${Math.round(d.durationSeconds / 60)} min` : "?"],
    ["Tracks", d.tracks.length ? d.tracks.map((t) => `${t.lang} (${t.kind})`).join(", ") : "none"],
  ];

  if (d.japanese) {
    rows.push(["Japanese", d.japanese.kind === "asr" ? "auto-generated" : "author-supplied"]);
    goButton.disabled = false;
    saveButton.disabled = false;
  } else {
    rows.push(["Japanese", "not available", "warn"]);
    show("No Japanese caption track on this video.", "err");
  }

  if (cachedHere) {
    rows.push(["Subtitles", `cached, ${cachedHere.lines} lines`]);
  }
  if (!d.playerReady) rows.push(["Player", "still loading", "warn"]);
  facts(rows);

  visButton.hidden = !cachedHere;
  paintVisButton();

  await refreshRunState();
}

function paintVisButton() {
  visButton.textContent = subsHidden ? "Show subtitles" : "Hide subtitles";
}

visButton.addEventListener("click", async () => {
  await withFeedback(visButton, null, async () => {
    subsHidden = !subsHidden;
    await chrome.storage.local.set({ subtitlesHidden: subsHidden });
    // If they were hidden and nothing is loaded on the page (a reload, or the
    // worker restarted), re-apply from cache rather than showing nothing.
    if (!subsHidden && cachedHere) {
      await chrome.runtime.sendMessage({ type: "subs:apply", tabId, videoId: currentVideoId });
    }
    await chrome.tabs.sendMessage(tabId, { type: "overlay:visible", visible: !subsHidden })
      .catch(() => {});
  });
  paintVisButton();
  show(subsHidden ? "Subtitles hidden." : "Subtitles showing.", "ok");
});

srtButton.addEventListener("click", async () => {
  srtButton.disabled = true;
  const built = await chrome.runtime.sendMessage({ type: "srt:get", videoId: currentVideoId });
  if (!built?.ok) {
    show(built?.error || "Could not build the .srt.", "err");
    srtButton.disabled = false;
    return;
  }
  const saved = await chrome.tabs.sendMessage(tabId, {
    type: "download:srt",
    srt: built.data.srt,
    title: built.data.title,
    videoId: built.data.videoId,
  }).catch((e) => ({ ok: false, error: e?.message }));

  show(
    saved?.ok
      ? `Saved ${saved.data.filename}
${built.data.lines} lines`
      : saved?.error || "Could not save the file.",
    saved?.ok ? "ok" : "err"
  );
  srtButton.disabled = false;
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  stopButton.textContent = "Stopping…";
  await chrome.runtime.sendMessage({ type: "run:stop", tabId });
  await refreshRunState();
});

async function startRun({ force = false } = {}) {
  srtButton.hidden = true;
  goButton.disabled = true;
  againButton.hidden = true;
  stopButton.hidden = false;
  stopButton.disabled = false;
  stopButton.textContent = "Stop translating";
  saveButton.disabled = true;
  show("Starting…", "ok");
  bar.removeAttribute("value"); // indeterminate

  stopPolling();
  poll = setInterval(refreshRunState, 500);

  const res = await chrome.runtime.sendMessage({ type: "run:start", tabId, force });
  await refreshRunState();
  if (res && !res.ok) {
    stopPolling();
    show(res.error, "err");
    goButton.disabled = false;
    goButton.textContent = GO_LABEL;
    saveButton.disabled = false;
    stopButton.hidden = true;
  }
}

goButton.addEventListener("click", startRun);

againButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "run:clear", tabId });
  // Bypass the cache: re-translate means re-translate.
  await startRun({ force: true });
});

saveButton.addEventListener("click", () =>
  withFeedback(saveButton, "Extracting…", async () => {
    const res = await toTab("extract:save");
    show(
      res.ok ? `Saved ${res.data.filename}\n${res.data.cue_count} cues` : res.error,
      res.ok ? "ok" : "err"
    );
  }));

init();
