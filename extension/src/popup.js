"use strict";

const $ = (id) => document.getElementById(id);
const goButton = $("go");
const saveButton = $("save");
const bar = $("bar");

let tabId = null;
let poll = null;

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
  const s = await chrome.storage.local.get(["model", "host"]);
  $("model").value = s.model || "";
  $("host").value = s.host || "";
}

for (const key of ["model", "host"]) {
  $(key).addEventListener("change", async (e) => {
    const value = e.target.value.trim();
    if (value) await chrome.storage.local.set({ [key]: value });
    else await chrome.storage.local.remove(key);
  });
}

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
        ? `Translating chunk ${state.done}/${state.total}`
        : state.phase === "analysing"
          ? "Reading the whole transcript…"
          : "Getting transcript…";
    show(phase, "ok");
    return;
  }

  stopPolling();
  setProgress(0, 0);
  bar.removeAttribute("value");
  goButton.disabled = false;
  saveButton.disabled = false;

  if (state.phase === "error") show(state.error, "err");
  else if (state.phase === "done") {
    const failed = state.failures?.length;
    show(
      `Done — ${state.units} lines.` +
      (failed ? `\n${failed} chunk problem(s); some lines may be blank.` : ""),
      failed ? "err" : "ok"
    );
  }
}

// --------------------------------------------------------------------- setup

async function init() {
  await loadSettings();

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

goButton.addEventListener("click", async () => {
  goButton.disabled = true;
  saveButton.disabled = true;
  show("Starting…", "ok");
  bar.removeAttribute("value"); // indeterminate

  stopPolling();
  poll = setInterval(refreshRunState, 500);

  const res = await chrome.runtime.sendMessage({ type: "run:start", tabId });
  await refreshRunState();
  if (res && !res.ok) {
    stopPolling();
    show(res.error, "err");
    goButton.disabled = false;
    saveButton.disabled = false;
  }
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
