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

/** Shortest time any line may stay on screen, however brief its source cue. */
const MIN_DWELL_MS = 500;

/** Longest a line may be held open by the reading-speed rule. */
const MAX_DWELL_MS = 6000;

/** Extra time a line lingers past its cue's end before blanking. */
const END_GRACE_MS = 400;

/**
 * Reading speed, characters per second (design §5.2).
 *
 * A flat minimum is not enough on its own: the complaint is that *long* lines
 * vanish instantly, and a 60-character sentence needs about three seconds
 * whatever its source cue was. Short lines still get MIN_DWELL_MS.
 */
const READING_CHARS_PER_SEC = 20;

function dwellFor(text) {
  const needed = (text.length / READING_CHARS_PER_SEC) * 1000;
  return Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, needed));
}

class Overlay {
  constructor() {
    this.units = [];          // [{ t_ms, end_ms, en }], sorted by t_ms
    this.host = null;
    this.box = null;
    this.video = null;
    this.player = null;
    this.timer = null;
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
        /* Top-right, clear of the subtitle band at the bottom and of the
           title overlay YouTube draws top-left on hover. */
        .status {
          position: absolute;
          top: 12px; right: 12px;
          max-width: 40%;
          font: 500 12px/1.4 "Segoe UI", system-ui, sans-serif;
          color: #fff;
          background: rgba(0, 0, 0, 0.66);
          padding: 5px 10px;
          border-radius: 4px;
          pointer-events: none;
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
      .sort((a, b) => a.t_ms - b.t_ms)
      .map((u) => ({
        ...u,
        // How long this line may stay up: whichever is longer, its own cue
        // plus grace, or enough time to actually read it.
        //
        // Overrunning the next unit is harmless — indexAt picks the latest
        // unit whose start has passed, so the next line takes over regardless.
        // This only extends lines that would otherwise hit a gap.
        until_ms: Math.max(u.end_ms + END_GRACE_MS, u.t_ms + dwellFor(u.en)),
      }));
    this.lastIndex = -1;
    this.setStatus("");
    console.debug(`[jpsub] overlay received ${this.units.length} units`);
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

  render = () => {
    if (!this.box || !this.video || !this.units.length) return;

    // Ads play in the same <video> element; showing a cue then would put the
    // wrong text on unrelated footage.
    if (this.player?.classList?.contains("ad-showing")) {
      if (this.box.textContent) this.box.textContent = "";
      return;
    }

    const ms = this.video.currentTime * 1000;
    const i = this.indexAt(ms);
    const unit = i >= 0 ? this.units[i] : null;

    // Past its end with nothing following yet: show nothing rather than
    // leaving a stale line on screen (§6.1).
    //
    // Compare the resulting TEXT, not the unit index. Indexing off the index
    // alone was a bug: within one unit's index the expiry never got
    // re-evaluated, so a line stayed on screen through the entire gap until
    // the next unit began.
    const text = unit && ms <= unit.until_ms ? unit.en : "";
    if (text !== this.box.textContent) this.box.textContent = text;
  };

  /**
   * Deliberately NOT requestAnimationFrame. rAF is tied to painting, and was
   * measured firing zero times per second on a visible but unpainted YouTube
   * tab — subtitles would simply stop. A timer plus the media events is driven
   * by playback instead, and 10 Hz is far finer than subtitles need.
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(this.render, 100);
    this.video?.addEventListener("timeupdate", this.render);
    this.video?.addEventListener("seeked", this.render);
    this.render(); // show the current line immediately, don't wait for a tick
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.video?.removeEventListener("timeupdate", this.render);
    this.video?.removeEventListener("seeked", this.render);
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
