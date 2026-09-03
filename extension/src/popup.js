"use strict";

const $ = (id) => document.getElementById(id);
const goButton = $("go");

function show(text, kind) {
  const el = $("msg");
  el.textContent = text;
  el.className = `show ${kind}`;
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

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(tabId, type) {
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

async function refresh() {
  const tab = await activeTab();
  if (!tab?.url?.includes("youtube.com")) {
    facts([["Status", "Not a YouTube page"]]);
    return;
  }

  const res = await send(tab.id, "detect");
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

  const langs = d.tracks.length
    ? d.tracks.map((t) => `${t.lang} (${t.kind})`).join(", ")
    : "none";

  const rows = [
    ["Duration", d.durationSeconds ? `${Math.round(d.durationSeconds / 60)} min` : "?"],
    ["Tracks", langs],
  ];

  if (d.japanese) {
    rows.push(["Japanese", d.japanese.kind === "asr" ? "auto-generated" : "author-supplied"]);
    goButton.disabled = false;
  } else {
    rows.push(["Japanese", "not available", "warn"]);
    goButton.disabled = true;
    show(
      "No Japanese caption track on this video. ASR fallback is not built yet " +
      "(design doc §1.3).",
      "err"
    );
  }

  if (!d.playerReady) {
    rows.push(["Player", "still loading", "warn"]);
  }

  facts(rows);
}

goButton.addEventListener("click", async () => {
  goButton.disabled = true;
  show("Enabling the caption track and waiting for the player to fetch it…", "ok");

  const tab = await activeTab();
  const res = await send(tab.id, "extract");

  if (!res.ok) {
    show(res.error, "err");
    goButton.disabled = false;
    return;
  }

  const d = res.data;
  const coverage =
    d.coverage_pct === null ? "" : `\nCoverage: ${d.coverage_pct}% of the video`;
  show(
    `Saved ${d.filename}\n${d.cue_count} cues${coverage}`,
    "ok"
  );
  goButton.disabled = false;
});

refresh();
