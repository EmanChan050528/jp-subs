"use strict";

const $ = (id) => document.getElementById(id);
const goButton = $("go");
const againButton = $("again");
const saveButton = $("save");
const bar = $("bar");

let tabId = null;
let poll = null;
let currentVideoId = null;
const GO_LABEL = "Translate & show subtitles";

/**
 * A finished run only counts for the video it ran on. This is keyed on the
 * current videoId because the run state lives in the worker and outlives a
 * navigation — without the check the button would stay disabled after moving
 * to a different video.
 */
function isDoneForThisVideo(state) {
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

$("clearCache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cache:clear" });
  await refreshCache();
});

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

async function refreshRunState() {
  const res = await chrome.runtime.sendMessage({ type: "run:status", tabId });
  const state = res?.data;
  if (!state) return;

  if (state.running) {
    goButton.disabled = true;
    saveButton.disabled = true;
    setProgress(state.done || 0, state.total || 0);
    const phase =
      state.phase === "translating" && state.total
        ? `Translating chunk ${state.done}/${state.total}` +
          (state.eta ? `\n~${state.eta} remaining` : "")
        : state.phase === "analysing"
          ? "Reading the whole transcript…"
          : "Getting transcript…";
    show(phase, "ok");
    return;
  }

  stopPolling();
  setProgress(0, 0);
  bar.removeAttribute("value");
  saveButton.disabled = false;

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

  if (state.phase === "error") show(state.error, "err");
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
  $("title").textContent = d.title || d.videoId || "";

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

  if (!d.playerReady) rows.push(["Player", "still loading", "warn"]);
  facts(rows);

  await refreshRunState();
}

async function startRun({ force = false } = {}) {
  goButton.disabled = true;
  againButton.hidden = true;
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
  }
}

goButton.addEventListener("click", startRun);

againButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "run:clear", tabId });
  // Bypass the cache: re-translate means re-translate.
  await startRun({ force: true });
});

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  show("Extracting…", "ok");
  const res = await toTab("extract:save");
  if (!res.ok) show(res.error, "err");
  else show(`Saved ${res.data.filename}\n${res.data.cue_count} cues`, "ok");
  saveButton.disabled = false;
});

init();
