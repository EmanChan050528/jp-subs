// Runs in the ISOLATED world. Deliberately thin: it owns nothing except the
// bridge between the popup (chrome.runtime messaging) and interceptor.js
// (window.postMessage), plus saving the result to disk.
//
// It cannot read ytInitialPlayerResponse or call the player's methods — those
// live in the page's world, which is why interceptor.js exists.

(() => {
  "use strict";

  const CHANNEL = "jpsub";
  const TIMEOUT_MS = 30000;

  let nextId = 1;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== "res") return;

    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error });
  });

  function ask(command) {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({
          ok: false,
          error:
            "The page script did not respond. Reload the YouTube tab — the " +
            "interceptor only installs on a fresh page load.",
        });
      }, TIMEOUT_MS);

      pending.set(id, { resolve, timer });
      window.postMessage({ channel: CHANNEL, dir: "req", id, command }, "*");
    });
  }

  function slug(s, fallback) {
    if (!s) return fallback;
    return s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 60) || fallback;
  }

  /** Trigger a download of arbitrary text. */
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return name;
  }

  function save(transcript) {
    return download(
      `${transcript.video_id}_${slug(transcript.title, "transcript")}.ja.json`,
      JSON.stringify(transcript, null, 2),
      "application/json"
    );
  }

  // ------------------------------------------------------------- overlay

  const overlay = new globalThis.JPSubOverlay();

  /** Which video this page is currently showing. */
  const currentVideoId = () => new URLSearchParams(location.search).get("v");

  /**
   * A run started on one video must never paint onto another. The worker
   * stamps its messages, and anything that does not match what the page is
   * showing right now is dropped.
   */
  function forThisVideo(msg) {
    if (!msg.videoId) return true;            // unstamped: legacy, allow
    const now = currentVideoId();
    if (!now || msg.videoId === now) return true;
    console.debug(`[jpsub] dropped ${msg.type} for ${msg.videoId}; page is on ${now}`);
    return false;
  }

  // If the player is not ready the payload must be held, not dropped. Losing
  // it means the run "succeeds" with no subtitles and nothing to point at.
  let heldUpdate = null;
  let mountRetry = null;

  function withOverlay(fn) {
    if (overlay.mount()) { fn(); return true; }
    console.debug("[jpsub] player not ready; holding overlay update");
    heldUpdate = fn;
    if (!mountRetry) {
      mountRetry = setInterval(() => {
        if (!heldUpdate || overlay.mount()) {
          clearInterval(mountRetry);
          mountRetry = null;
          const held = heldUpdate;
          heldUpdate = null;
          if (held) held();
        }
      }, 500);
    }
    return false;
  }

  // YouTube is an SPA: a new video reuses the document, so the old video's
  // subtitles must not survive the navigation.
  window.addEventListener("yt-navigate-finish", () => {
    overlay.clear();
    chrome.runtime.sendMessage({ type: "run:clear" }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "overlay:units") {
      if (!forThisVideo(msg)) { sendResponse({ ok: true, dropped: true }); return false; }
      console.debug(`[jpsub] overlay:units received (${msg.units?.length ?? 0})`);
      withOverlay(() => {
        overlay.setUnits(msg.units);
        overlay.setStatus(msg.status || "");
      });
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "overlay:status") {
      if (!forThisVideo(msg)) { sendResponse({ ok: true, dropped: true }); return false; }
      withOverlay(() => overlay.setStatus(msg.text));
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "overlay:clear") {
      overlay.clear();
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "download:srt") {
      try {
        const name = `${msg.videoId}_${slug(msg.title, "subtitles")}.en.srt`;
        download(name, msg.srt, "text/plain;charset=utf-8");
        sendResponse({ ok: true, data: { filename: name } });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return false;
    }

    if (msg?.type === "detect") {
      ask("detect").then(sendResponse);
      return true; // async
    }

    // Full transcript, cues included, nothing written to disk. This is what the
    // service worker consumes.
    if (msg?.type === "extract") {
      ask("extract").then(sendResponse);
      return true; // async
    }

    // Same extraction, but saved as a file and answered with a summary.
    if (msg?.type === "extract:save") {
      ask("extract").then((res) => {
        if (!res.ok) return sendResponse(res);
        try {
          const filename = save(res.data);
          const { cues, ...summary } = res.data;
          sendResponse({ ok: true, data: { ...summary, filename } });
        } catch (err) {
          sendResponse({ ok: false, error: `Saved nothing: ${err?.message || err}` });
        }
      });
      return true; // async
    }

    return false;
  });
})();
