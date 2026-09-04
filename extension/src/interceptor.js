// Runs in the page's MAIN world at document_start.
//
// Everything here needs page-level access and cannot be done from an isolated
// content script:
//   - hooking fetch/XHR *before* YouTube's player caches its own references
//   - reading ytInitialPlayerResponse
//   - calling the player's own methods (loadModule / setOption)
//
// It talks to content.js over window.postMessage.
//
// Strategy (see translator-design.md §1.2, and the measurements that produced it):
//
//   Caption content requires a proof-of-origin token (pot) minted by YouTube's
//   attestation code. We do not reimplement it. Instead we make the player
//   fetch *some* caption track, read the tokenised URL off the wire, and then
//   rewrite it to the track we actually want.
//
//   The rewrite is what makes this robust. The signature covers only
//   sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf — `lang`, `kind` and
//   `tlang` are NOT signed. Verified by round-tripping a URL through
//   lang=en&tlang=en and back to lang=ja&kind=asr: byte-identical response.
//
//   This matters because asking the player for the Japanese track is
//   unreliable. On a UI set to English, setOption('captions','track',…) with a
//   fully-specified Japanese option still selects English. So we stop caring
//   what the player picked and rewrite the URL ourselves.

(() => {
  "use strict";

  const CHANNEL = "jpsub";
  const MAX_REMEMBERED = 20;

  /** pot-bearing timedtext URLs seen on the wire, oldest first. */
  let captured = [];

  // ---------------------------------------------------------------- network

  const isTimedText = (u) => typeof u === "string" && u.includes("/api/timedtext");

  function remember(url) {
    // A URL without a token is useless — it returns an empty 200. Any track
    // will do, though: we rewrite it to Japanese below.
    if (!url.includes("pot=")) return;
    if (captured.includes(url)) return;
    captured.push(url);
    if (captured.length > MAX_REMEMBERED) captured.shift();
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (isTimedText(url)) remember(url);
    } catch { /* never let instrumentation break the page */ }
    return originalFetch.apply(this, args);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (isTimedText(url)) remember(String(url));
    } catch { /* as above */ }
    return originalOpen.call(this, method, url, ...rest);
  };

  // YouTube is a single-page app; a new video does not reload the document.
  window.addEventListener("yt-navigate-finish", () => { captured = []; });

  // ----------------------------------------------------------------- player

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function param(url, key) {
    try { return new URL(url, location.origin).searchParams.get(key); }
    catch { return null; }
  }

  function player() {
    return document.querySelector("#movie_player");
  }

  // ytInitialPlayerResponse goes stale across SPA navigation; the player's own
  // accessor is authoritative once it exists.
  function playerResponse() {
    const p = player();
    if (p && typeof p.getPlayerResponse === "function") {
      try {
        const r = p.getPlayerResponse();
        if (r) return r;
      } catch { /* fall through */ }
    }
    return window.ytInitialPlayerResponse || null;
  }

  function videoId() {
    return playerResponse()?.videoDetails?.videoId
      || new URLSearchParams(location.search).get("v");
  }

  function captionTracks() {
    return playerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  function japaneseTrack() {
    return captionTracks().find((t) => t.languageCode === "ja") || null;
  }

  /** Newest captured token URL belonging to the current video, whatever track. */
  function tokenUrl() {
    const id = videoId();
    for (let i = captured.length - 1; i >= 0; i--) {
      if (param(captured[i], "v") === id) return captured[i];
    }
    return null;
  }

  /**
   * Point a captured token URL at the Japanese track.
   * Safe because lang/kind/tlang are outside the signed sparams set.
   */
  function pointAtJapanese(url, track) {
    const u = new URL(url, location.origin);
    u.searchParams.delete("tlang");        // drop YouTube's own translation
    u.searchParams.set("lang", "ja");
    if (track.kind) u.searchParams.set("kind", track.kind);
    else u.searchParams.delete("kind");
    u.searchParams.set("fmt", "json3");
    return u.toString();
  }

  /**
   * Get the player to issue *any* tokenised caption request. We do not care
   * which track it chooses — the URL is rewritten afterwards.
   */
  async function triggerCaptionFetch() {
    const p = player();
    if (!p || typeof p.loadModule !== "function") {
      throw new Error("YouTube player API not available on this page yet.");
    }

    const track = japaneseTrack();
    const option = {
      languageCode: "ja",
      kind: track.kind || "",
      name: track.name?.simpleText || "",
      vss_id: track.vssId || "",
    };

    // Turning captions on is a side effect of minting the token, not something
    // the viewer asked for. Remember what was showing so it can be put back —
    // otherwise YouTube's own subtitles are left on top of ours.
    let previous = null;
    try { previous = p.getOption("captions", "track"); } catch { /* ignore */ }

    try {
      p.loadModule("captions");
      await sleep(800);
      p.setOption("captions", "track", option);

      // Poll rather than sleeping a fixed time — the request lands whenever the
      // player gets round to it.
      for (let i = 0; i < 20 && !tokenUrl(); i++) await sleep(250);

      // The player will not refetch a track it already holds. Toggling forces a
      // fresh, token-bearing request.
      if (!tokenUrl()) {
        p.setOption("captions", "track", {});
        await sleep(500);
        p.setOption("captions", "track", option);
        for (let i = 0; i < 24 && !tokenUrl(); i++) await sleep(250);
      }
    } finally {
      restoreCaptions(p, previous);
    }
  }

  /**
   * Put YouTube's caption selection back the way the viewer had it. An empty
   * object turns captions off, which is the right answer when they were off to
   * begin with — the common case, since our own subtitles replace them.
   */
  function restoreCaptions(p, previous) {
    try {
      const hadCaptions = !!previous && !!previous.languageCode;
      p.setOption("captions", "track", hadCaptions ? previous : {});
    } catch (err) {
      console.debug("[jpsub] could not restore captions:", err?.message || err);
    }
  }

  // ------------------------------------------------------------------ fetch

  async function fetchTrack(url) {
    const res = await fetch(url, { credentials: "include" });
    const body = await res.text();

    // The single most important check in this extension. Without a valid token
    // the endpoint answers HTTP 200 with a zero-length body — a refusal that is
    // otherwise indistinguishable from success. Never treat it as "no captions".
    if (!body) {
      throw new Error(
        `timedtext returned HTTP ${res.status} with an empty body. That is a ` +
        `refusal (missing or expired proof-of-origin token), not a video ` +
        `without captions. Reload the tab and try again.`
      );
    }
    return JSON.parse(body);
  }

  /**
   * json3 -> the flat cue list the rest of the pipeline expects.
   *
   * `segs` carries YouTube's per-word timings (`tOffsetMs`, relative to the
   * event start) converted to absolute ms. Roughly half of all cues have them,
   * and they let segmentation place a sentence break at a real timestamp
   * instead of estimating one from character counts.
   */
  function toCues(json3) {
    return (json3.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        t_ms: e.tStartMs,
        dur_ms: e.dDurationMs,
        ja: e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim(),
        segs: e.segs.map((s) => ({
          t_ms: e.tStartMs + (s.tOffsetMs || 0),
          text: (s.utf8 || "").replace(/\n/g, " "),
        })),
      }))
      .filter((c) => c.ja);
  }

  // --------------------------------------------------------------- commands

  const commands = {
    detect() {
      const pr = playerResponse();
      const track = japaneseTrack();
      return {
        onWatchPage: !!new URLSearchParams(location.search).get("v"),
        videoId: videoId(),
        title: pr?.videoDetails?.title || null,
        channelId: pr?.videoDetails?.channelId || null,
        author: pr?.videoDetails?.author || null,
        durationSeconds: Number(pr?.videoDetails?.lengthSeconds) || null,
        playerReady: typeof player()?.loadModule === "function",
        tracks: captionTracks().map((t) => ({
          lang: t.languageCode,
          kind: t.kind || "manual",
        })),
        japanese: track ? { kind: track.kind || "manual" } : null,
        haveTokenUrl: !!tokenUrl(),
      };
    },

    async extract() {
      const pr = playerResponse();
      const track = japaneseTrack();
      if (!track) throw new Error("This video has no Japanese caption track.");

      if (!tokenUrl()) await triggerCaptionFetch();

      const seed = tokenUrl();
      if (!seed) {
        throw new Error(
          "Could not capture a tokenised caption request. Press C on the video " +
          "to turn captions on, then extract again."
        );
      }

      const cues = toCues(await fetchTrack(pointAtJapanese(seed, track)));
      const duration = Number(pr?.videoDetails?.lengthSeconds) || null;
      const lastCue = cues.length ? Math.round(cues[cues.length - 1].t_ms / 1000) : 0;

      return {
        video_id: videoId(),
        title: pr?.videoDetails?.title || null,
        channel_id: pr?.videoDetails?.channelId || null,
        author: pr?.videoDetails?.author || null,
        duration_s: duration,
        source: `youtube caption track (kind=${track.kind || "manual"}, lang=ja)`,
        captured_at: new Date().toISOString(),
        cue_count: cues.length,
        last_cue_s: lastCue,
        coverage_pct: duration ? Math.round((lastCue / duration) * 100) : null,
        cues,
      };
    },
  };

  // --------------------------------------------------------------- messaging

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== "req") return;

    const reply = (payload) =>
      window.postMessage({ channel: CHANNEL, dir: "res", id: msg.id, ...payload }, "*");

    const fn = commands[msg.command];
    if (!fn) return reply({ ok: false, error: `Unknown command: ${msg.command}` });

    try {
      reply({ ok: true, data: await fn() });
    } catch (err) {
      reply({ ok: false, error: err?.message || String(err) });
    }
  });

  console.debug("[jpsub] interceptor installed in MAIN world");
})();
