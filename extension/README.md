# Extension — build step 1

Extracts the Japanese caption track from a YouTube video and saves it as JSON.
**No translation and no subtitle rendering yet** — that is build steps 2 and 3.

This step exists first because of what the caption-access testing found: the
content of a caption track is only reachable from inside a live player session
(see `../translator-design.md` §1.2). A CLI cannot do it, so the risky part is
built before anything depends on it.

## Load it

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` directory
4. Open a YouTube video with Japanese audio and **reload the tab**

The reload matters. The interceptor must install at `document_start` to hook
the network before YouTube's player caches its own `fetch` reference. Loading
the extension while a YouTube tab is already open will not attach it.

## Use it

Click the toolbar icon. The popup reports what it found; press
**Extract Japanese transcript** to save a `.json` file to your downloads.

Output shape:

```json
{
  "video_id": "EmteTL5Ij8g",
  "title": "…",
  "duration_s": 28382,
  "source": "youtube caption track (kind=asr, lang=ja)",
  "cue_count": 11457,
  "coverage_pct": 100,
  "cues": [{ "t_ms": 1802240, "dur_ms": 3200, "ja": "いつの話なんてか。" }]
}
```

This matches `../eval/fixtures/*.ja.json`, so extracted transcripts drop
straight into the evaluation set.

## How it works

| File | World | Job |
|---|---|---|
| `src/interceptor.js` | **MAIN** | Hooks `fetch`/`XHR`, reads `ytInitialPlayerResponse`, drives the player, fetches the track |
| `src/content.js` | ISOLATED | Bridge between the popup and the page; saves the file |
| `src/popup.js` | — | UI |

The split is forced, not stylistic. The player's methods and
`ytInitialPlayerResponse` are page objects that an isolated content script
cannot touch, so detection and caption-enabling have to live in the MAIN world
next to the network hook.

**The token.** Caption content requires a proof-of-origin token (`pot`) minted
by YouTube's own attestation code. This extension does not reimplement it — it
gets the player to fetch *some* caption track, then reads the tokenised URL
back off the wire.

**The rewrite, and why it matters.** We do not care which track the player
picked. The signature covers only
`sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf` — `lang`, `kind` and `tlang`
are **not signed** — so a captured URL can be repointed at any track.
`pointAtJapanese()` does this.

This is not an optimisation, it works around a real defect: asking the player
for the Japanese track is unreliable. On a UI set to English,
`setOption('captions','track', …)` with a fully-specified Japanese option
**still selects English**, verified on a live video. Rewriting removes the
dependency on the player cooperating.

**The empty-200 trap.** Without a valid token the endpoint returns HTTP 200
with a zero-length body. That is a refusal, and it is indistinguishable from
success unless the body length is checked. `fetchTrack()` checks it explicitly
and raises. Do not weaken this — silently reporting "no captions" for a video
that has them is the most likely bug in this project.

## Verify it works

Test against these, in order:

- [ ] A VTuber archive with an auto-generated Japanese track — the normal case
- [ ] A long archive (4h+) — confirms one request returns the whole track
- [ ] A video with no Japanese track — should say so, not fail obscurely
- [ ] A non-video YouTube page — popup should degrade cleanly
- [ ] **Navigate between two videos without reloading** — the SPA case; see below

## Known gaps

- [ ] **SPA navigation is only partly handled.** `yt-navigate-finish` clears the
      captured URLs, but this has not been tested against a real
      video-to-video navigation. If extraction misbehaves after navigating,
      reload the tab and re-check before assuming a deeper bug.
- [ ] **Timing is bounded polling.** `triggerCaptionFetch()` polls `tokenUrl()`
      for ~5 s, then toggles the track and polls another ~6 s. That is a guess
      at a worst case, not a measurement. If extraction times out on slow
      connections, raise the bounds.
- [ ] **Shorts are not handled specially.** They use the same watch URL and
      appear to work, but this is untested.
- [ ] **No ASR fallback** for videos without a Japanese track (design §1.3).

## What has been verified

Run against live YouTube on 2026-09-03, executing the shipped helper functions
verbatim in the page:

| Check | Result |
|---|---|
| `getPlayerResponse()`, `vssId`, `kind`, `name.simpleText` field names | all correct |
| `setOption` selects the Japanese track | **fails** — selects English; this is why the rewrite exists |
| `pointAtJapanese()` on an English-flavoured URL | returns the Japanese track |
| `fetchTrack()` + `toCues()` end to end | 5,729 cues, 100% coverage |
| Empty-200 guard on an un-rewritten URL | raises, as intended |
| Output shape | matches `../eval/fixtures/*.ja.json` |

**First real run, 2026-09-03 — worked on the first try.** Loaded unpacked in
Chrome, extracted `NSY6YHXbxtA` (21:52) via the popup button: 202 cues, 100%
coverage, monotonic timestamps, no empty strings, schema identical to the
existing fixtures. Saved as `../eval/fixtures/NSY6YHXbxtA_full.ja.json`.

That clears the two gaps that could not be checked from outside a browser:

- **MV3 packaging works** — manifest, `world: "MAIN"`, popup wiring, download.
- **The `document_start` hook works.** This was the main risk. A hook installed
  after page load provably fails, because the player caches its own `fetch`
  first; a successful extraction proves the early hook beat it.
