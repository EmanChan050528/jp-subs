// Subtitle overlay. Runs in the ISOLATED world alongside content.js.
//
// Two decisions carried over from the design doc:
//
// Seeking must be instant (§0.2). The translation is held as a complete, sorted
// list and the active cue is resolved from video.currentTime by binary search,
// so jumping anywhere in the video is O(log n) and needs no replay of state.
//
// The overlay is anchored to the player, not the page (§5.1), so fullscreen and
// theatre mode come for free — the player element is what goes fullscreen.

const HOST_ID = "jpsub-overlay-host";

class Overlay {
  constructor() {
    this.units = [];          // [{ t_ms, end_ms, en }], sorted by t_ms
    this.host = null;
    this.box = null;
    this.video = null;
    this.player = null;
    this.raf = null;
    this.lastIndex = -1;
    this.status = "";
  }

  // ------------------------------------------------------------------ mount

  mount() {
    this.player = document.querySelector("#movie_player");
    this.video = document.querySelector("video");
    if (!this.player || !this.video) return false;
    if (this.host && this.player.contains(this.host)) return true;

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    // The host is inert; everything visible lives in the shadow root so the
    // page's CSS cannot reach it and ours cannot leak out.
    this.host.style.cssText =
      "position:absolute;left:0;right:0;bottom:0;top:0;pointer-events:none;z-index:60;";

    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .wrap {
          position: absolute;
          left: 0; right: 0; bottom: 8%;
          display: flex; justify-content: center;
          pointer-events: none;
          padding: 0 6%;
        }
        .cue {
          font: 600 clamp(14px, 2.1vw, 28px)/1.32
                "Segoe UI", system-ui, -apple-system, sans-serif;
          color: #fff;
          text-align: center;
          white-space: pre-wrap;
          background: rgba(0, 0, 0, 0.62);
          padding: 0.18em 0.6em;
          border-radius: 4px;
          /* Outline as well as a plate: subtitles sit over arbitrary video. */
          text-shadow:
            -1px -1px 0 #000, 1px -1px 0 #000,
            -1px  1px 0 #000, 1px  1px 0 #000;
          max-width: 100%;
        }
        .cue:empty, .wrap.hidden { display: none; }
        .status {
          position: absolute;
          left: 50%; transform: translateX(-50%);
          bottom: 8%;
          font: 500 13px/1.4 "Segoe UI", system-ui, sans-serif;
          color: #fff;
          background: rgba(0, 0, 0, 0.72);
          padding: 6px 12px;
          border-radius: 4px;
        }
        .status:empty { display: none; }
      </style>
      <div class="wrap"><div class="cue"></div></div>
      <div class="status"></div>
    `;

    this.box = root.querySelector(".cue");
    this.statusBox = root.querySelector(".status");
    this.player.appendChild(this.host);
    return true;
  }

  // ----------------------------------------------------------------- content

  setUnits(units) {
    this.units = (units || [])
      .filter((u) => u.en && u.en.trim())
      .sort((a, b) => a.t_ms - b.t_ms);
    this.lastIndex = -1;
    this.setStatus("");
    this.start();
  }

  setStatus(text) {
    this.status = text || "";
    if (this.statusBox) this.statusBox.textContent = this.status;
  }

  clear() {
    this.units = [];
    this.lastIndex = -1;
    if (this.box) this.box.textContent = "";
    this.setStatus("");
  }

  // ------------------------------------------------------------------ timing

  /** Rightmost unit whose start is <= t. */
  indexAt(ms) {
    let lo = 0;
    let hi = this.units.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.units[mid].t_ms <= ms) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  }

  tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.box || !this.video || !this.units.length) return;

    // Ads play in the same <video> element; showing a cue then would put the
    // wrong text on unrelated footage.
    if (this.player?.classList?.contains("ad-showing")) {
      if (this.lastIndex !== -1) { this.box.textContent = ""; this.lastIndex = -1; }
      return;
    }

    const ms = this.video.currentTime * 1000;
    const i = this.indexAt(ms);

    if (i === this.lastIndex) return;
    this.lastIndex = i;

    const unit = i >= 0 ? this.units[i] : null;
    // Past its end with nothing following yet: show nothing rather than
    // leaving a stale line on screen (§6.1).
    this.box.textContent = unit && ms <= unit.end_ms + 400 ? unit.en : "";
  };

  start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  destroy() {
    this.stop();
    this.host?.remove();
    this.host = null;
    this.box = null;
  }
}

// Content scripts cannot be ES modules, so publish on the shared isolated-world
// global instead of exporting. overlay.js is listed before content.js.
globalThis.JPSubOverlay = Overlay;
