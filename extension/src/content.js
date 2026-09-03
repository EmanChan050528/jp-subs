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

  function save(transcript) {
    const name = `${transcript.video_id}_${slug(transcript.title, "transcript")}.ja.json`;
    const blob = new Blob([JSON.stringify(transcript, null, 2)], {
      type: "application/json",
    });
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "detect") {
      ask("detect").then(sendResponse);
      return true; // async
    }

    if (msg?.type === "extract") {
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
