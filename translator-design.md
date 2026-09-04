# Japanese → English Subtitles for YouTube VOD

A browser extension that takes a YouTube video, obtains a Japanese transcript, translates it with a **local model through Ollama**, and renders English subtitles over the player.

> **Status: built and in use.** All four build steps are complete. This document is now a record of the design and the reasoning behind it, updated to match what was actually built and measured. Where a prediction turned out wrong, the correction is kept alongside it rather than quietly replaced — the wrong predictions are the useful part.
>
> Setup and usage live in [README.md](README.md). Component detail is in [extension/README.md](extension/README.md), [core/README.md](core/README.md) and [eval/README.md](eval/README.md).

**Scope:** YouTube VOD, and nothing else. Not live streams (the real-time pipeline is preserved in [Appendix A](#appendix-a--deferred-live-stream-pipeline) rather than kept in the design), not other video sites, not local files, not microphone input. Build directly against YouTube — do not add abstraction layers for sources that are not in scope.

**Key constraint:** an LLM does not accept audio input. In practice this barely matters — YouTube auto-generates a Japanese caption track for nearly all target content (§1.4), so the input is already text. ASR remains the unbuilt fallback for the minority of videos with no track.

**What VOD buys us.** No latency budget, no VAD, no streaming ASR, no speculative translation, no backpressure. In exchange we get the whole transcript up front — which proved to be the single largest quality win available for Japanese (§3.2), and which made a local model viable at all.

---

## Stage 0 — Scope and Targets

### 0.1 Languages

- **Source: Japanese.** Chinese and Korean were raised as possible later additions, but nothing in this design should be built to accommodate them — the §3.3 handling is Japanese-specific and would not transfer anyway. Add them, if ever, as a separate prompt and a separate evaluation.
- **Target: English.**

### 0.2 Platform and content

- **Browser extension (Chrome, Manifest V3).**
- **YouTube VOD only** — archived anime and VTuber stream archives.

Write against YouTube directly. A generic "transcript source" interface, a pluggable player adapter, or a site-agnostic overlay would all be speculative generality here: there is one host page, one player, and one caption format. Couple to them and keep the code small.

Because everything runs offline relative to playback, the MV3 service-worker lifetime problem mostly disappears: work is request-shaped and short-lived rather than a persistent capture session. Confirm this holds for long VTuber archives, where a single video's translation may take minutes.

#### YouTube host-page constraints

- [x] **Anchor the overlay to the player**, not the page — theatre mode and fullscreen come free
- [x] **Handle seeking.** Stored as a complete timed list; the active cue is found by binary search over `video.currentTime`, so a seek resolves instantly
- [x] Ads hidden — the overlay blanks while the player carries `ad-showing`
- [x] **Overlay isolation** — a shadow root attached to the player element
- [x] ~~**API key handling.**~~ Moot: the model runs locally, so there is no key to ship. Ollama's `OLLAMA_ORIGINS` had to be opened to `chrome-extension://*` instead — it answers 403 to unknown origins with no useful message.

One prediction here was wrong. The doc said the MV3 service-worker lifetime problem "mostly disappears" because work is request-shaped. It does not: a translation is a single unbroken chain of fetches lasting up to 17 minutes. It has held in practice, but it is the least-tested assumption in the project.

### 0.3 Timing targets

**All targets met, and the design they implied was not needed.**

| Target | Predicted | Measured (`qwen3.5:9b`, RTX 5070) |
|---|---|---|
| Full 24-minute episode | ≤ 90 s | ~51 s |
| 7h53m archive | — | 1,011 s (16m 51s) |
| Throughput | faster than real time | **28× real time** |

- [x] **Progressive, not blocking** — results are pushed after every chunk, so subtitles appear before the whole video is done
- [x] ~~Ahead-of-playhead scheduling~~ — **dropped, and rightly.** It was designed for a world where translation was slow. At 28× real time the entire video finishes before a viewer reaches the second minute, so scheduling around the playhead would add complexity for no gain. Chunks are simply translated in order.
- [x] ~~Handle a seek past the translated region~~ — the progress box covers this; there is no meaningful window in which a viewer can outrun the translator.

### 0.4 Cost — resolved by moving off the API entirely

**This section used to model Claude API pricing in detail. That analysis is obsolete.**

The Claude API turned out to be billed separately from a Claude Pro subscription, which was not budgeted for. Gemini's free tier and a local model were both considered; local Qwen through Ollama was chosen and shipped. See [docs/translation-backends.md](docs/translation-backends.md).

**Cost is now zero per video.** No API key, no per-token billing, no cost ceiling to design against. The constraint it was replaced by is *hardware*: translation speed is bounded by local GPU throughput, and model choice is the only meaningful lever on it.

The old analysis is worth one line of retrospect: it concluded "cost has stopped being a design constraint" at ~$0.09 per episode, and that conclusion survived the move — it just became literally true rather than approximately.

What *did* carry over from it:

- [x] **Cache the finished translation per video** so a re-watch costs nothing (§4.2). Still worth it — the cost is now 17 minutes of GPU rather than dollars.
- [x] **Chunk size is not a lever.** Measured: 20 units/chunk took 14.8 s, 40 units/chunk with narrower context took 14.0 s. The cost is generating output tokens, which chunking does not change.
- [x] **Model choice is the lever**, so the extension lists the models Ollama has installed and lets the user pick.

---

## Stage 1 — Transcript Acquisition

**This stage was tested against live YouTube on 2026-09-03 before the rest of the design was trusted. Findings below are measured, not assumed.** See §1.5 for the raw results.

### 1.1 How caption access actually works

Two separate things, with very different access rules:

- **Track metadata** (which languages exist, manual or auto-generated) is embedded in the watch page HTML and readable with a plain HTTP GET. No auth, no tokens. Reliable across every video sampled.
- **Track content** requires a **proof-of-origin token** (`pot`) on the `/api/timedtext` request. The `baseUrl` published in the page does *not* contain one.

Without a valid `pot`, `timedtext` returns **HTTP 200 with an empty body** — a silent refusal, not an error. With the same URL plus a valid `pot`, the full transcript comes back. This was confirmed by replaying one URL with and without the token in the same browser session with the same cookies; nothing else differed.

- [ ] **Never treat an empty 200 as "this video has no captions."** It is indistinguishable from success unless the body is checked. This is the single most likely silent-failure bug in the project.

### 1.2 The viable acquisition path

The `pot` is minted by YouTube's own attestation code inside the player. Do not try to reimplement it — ride the player instead:

1. Content script detects a Japanese track from the page metadata.
2. Extension enables that track on the player. **Verified working** via `player.setOption('captions', 'track', …)`, and via the `c` keyboard shortcut when the API is uncooperative.
3. The player issues its own `pot`-bearing `timedtext` request.
4. Extension observes that request and re-fetches the URL. **Verified: replaying a captured `pot` URL returns the full transcript.**

- [ ] Capture the URL by injecting into the **MAIN world at `document_start`**. A hook installed after page load does not work — the player captures its own reference to `fetch` before that, which was confirmed in testing (a post-load hook saw nothing while the request was visibly made).
- [ ] `chrome.webRequest` observation is the alternative if main-world injection proves brittle
- [ ] **Consequence: this cannot be done from a server or a plain CLI.** Caption content is only reachable from inside a real player session. The build order (below) is arranged around this.

### 1.3 What the transcript looks like

Measured on a 7h53m VTuber archive (`EmteTL5Ij8g`, 28,382 s):

| | |
|---|---|
| Response | 4.34 MB, `fmt=json3` |
| Cues | 11,457 (~24/min) |
| Coverage | last cue at 28,377 s of 28,382 s — **the whole video in one request** |
| Japanese characters | 75,088 |
| Punctuation | **present** (`。` `、`) |

- [x] **One request returns the entire track**, regardless of length. No pagination, no time-range parameters. Simplifies Stage 4 considerably.
- [x] ~~Auto-generated Japanese has no punctuation~~ — **wrong, and now corrected.** YouTube's Japanese ASR punctuates. The punctuation-restoration pre-pass previously planned for §3.1 is **not needed**.
- [ ] **Cue granularity varies widely between videos, and both extremes are `kind=asr`.** On the 7h53m archive the mean cue is ~6.6 characters — scrolling fragments that break mid-clause (`"でももうに"`). On a 21:52 clip extracted later the mean is 16.0, the maximum is 75, and cues are mostly complete punctuated sentences. Stage 2 must handle both, and must not mangle already-whole sentences while repairing fragments. Both cases are kept as regression fixtures in `eval/fixtures/`.

### 1.4 Track availability — measured

20 videos sampled (10 long-form VTuber archives, 10 anime searches):

| | VTuber | Anime |
|---|---|---|
| Author-supplied Japanese | 0 | 0 |
| Auto-generated Japanese | 10 | 7 |
| No Japanese track | 0 | 3 |

- [x] ~~Tier 1, author-supplied tracks~~ — **effectively does not exist for this content.** Zero of twenty. Do not build a path for it; if one turns up it is just a higher-quality input to the same pipeline.
- [ ] **Auto-generated is the primary and normal case**, not a degraded fallback. Design for it.
- [ ] **ASR fallback is still needed** for roughly the 15% of anime with no track at all. Same as before: offline, accuracy-only, benchmarked on VTuber audio, with singing suppressed. Surface its cost and processing time to the user before running it.
- [ ] Sample sizes are small and search-biased — re-check against a real watch list before relying on the percentages.

### 1.5 Fragility and what breaks

- [ ] `pot` is bot-defence machinery: undocumented, and expected to change. Riding the player's own request is more durable than minting tokens ourselves, but it is not stable ground.
- [ ] Isolate all of this in one module with an explicit health check, so a break is detected and reported rather than surfacing as videos that silently have no subtitles
- [ ] Watch for the empty-200 case specifically as the health signal

### 1.6 Content profiles

| | Anime | VTuber archive |
|---|---|---|
| Speech | Scripted, clearly enunciated | Unscripted, fast, overlapping, heavy fillers |
| Lines | ~290 per episode | ~5,000 per 4-hour archive |
| Register | Wide, deliberate role language (役割語) | Casual, slang, net-speak, in-jokes |
| Vocabulary | Fixed per series | Fixed per streamer, plus fast-moving memes |
| Caption tracks | Auto-generated only (0/10 manual) | Auto-generated, or none (3/10 had none) |
| Measured cue rate | — | ~24/min |

- [ ] **Chat reading.** Streamers read Japanese superchats aloud, switching register and referent mid-sentence with no cue. Expect pronoun resolution (§3.3) to fail hardest here.
- [ ] Role language matters more for anime, slang and memes more for VTubers — likely two system prompts, not one

---

## Stage 2 — Document Preparation

- [ ] Normalise all three tiers into one internal format: a list of `{start, end, text}` cues
- [x] **Re-segment into translation units.** Built in `segment.js`, and it turned out to be the subtlest part of the project. Working at cue level cannot win, because the two content profiles need opposite treatment: cues are exploded into sentence pieces, then pieces accumulate until sentence-final punctuation, a 2 s silence, or a 64-character cap. One rule, both shapes — 131 cues → 78 units on a fragmented video (merging), 202 → 235 on a sentence-dense one (splitting).
- [x] **Sentence breaks land on real timestamps.** YouTube's json3 carries word-level timings (`tOffsetMs`) on roughly half of all cues, which the first implementation discarded and replaced with a character-count estimate. Switching to the real timings moved 22 of 78 unit starts, the worst by 4.3 s, and cut out-of-order units on a long video from **172 to 0**.
- [ ] Restore punctuation and sentence boundaries for Tier 2 input (§1.2)
- [ ] Chunk into requests: ~20 lines per request with ~10 lines of preceding overlap for context
- [ ] Decide chunk boundaries on sentence boundaries, never mid-clause

---

## Stage 3 — Translation

### 3.1 Two-pass design

Having the whole transcript up front makes a first pass possible, and it is where most of the quality comes from:

- [ ] **Pass 1 — analysis (once per video).** Read the full transcript and extract: character names and how they are written, speaker roles and relationships, recurring terms and in-jokes, register per speaker, and the domain. Output a compact glossary.
- [ ] **Pass 2 — translation (per chunk).** Translate with that glossary as the cached prefix.
- [ ] Pass 1 costs one request over a long input and pays for itself immediately in consistency — the same name rendered three different ways across an episode is the most obvious tell of a machine translation.
- [x] ~~Fold punctuation restoration into pass 1~~ — not needed; YouTube's Japanese ASR output is already punctuated (§1.3)

### 3.2 Context — the VOD advantage

Under the real-time design, context was a backwards-looking rolling window and pronoun resolution was guesswork. Here the model can see **ahead** as well as behind.

- [ ] Include following lines as well as preceding ones in each chunk
- [ ] This is the single biggest quality win available for Japanese: a dropped subject is frequently disambiguated by what comes *next*, which a live pipeline can never see
- [ ] Tune the window sizes; they are cheap here, unlike in the live design

### 3.3 Japanese-specific translation problems

These remain the top quality risks.

- [ ] **Pro-drop.** Japanese omits subjects constantly, and unlike Spanish there is no verb agreement to recover person from. 「行った」 is "I / you / he / she / they went" with no marking at all. English forces a pronoun on nearly every line, and a wrong guess is visible and jarring. §3.2's forward context and §3.1's speaker map are the mitigations.
- [ ] **Recover person from honorifics, not just context.** Giving and receiving verbs and keigo encode direction: 「くれる」 (someone did it for me) vs 「あげる」 (I did it for someone); humble forms mark the speaker, honorific forms mark the addressee. Teach these in the system prompt — they resolve many pronouns that surrounding lines cannot.
- [ ] **Verb-final word order (SOV).** Negation, tense, and politeness land on the final morphemes. Never split a chunk mid-clause (§2).
- [ ] **Role language (役割語).** Fiction encodes character through speech style — pronoun choice (`俺` / `僕` / `私` / `わし`), sentence-ending particles, dialect. Flattening every character into neutral English loses most of the characterisation. Decide how much to attempt; the §3.1 speaker map makes it achievable.
- [ ] **Register.** Casual / polite / humble / honorific are grammatically marked in Japanese and only lexically available in English. Define a consistent mapping rather than letting it drift.
- [ ] **Sentence-boundary mismatch.** Japanese and English clause order differ enough that a strict one-in-one-out mapping reads badly. Allow merging and splitting, and remap timings accordingly (§5.2).

### 3.4 Request design and caching

- [ ] System prompt: domain, register, output format constraints; suppress preamble and commentary
- [ ] Return structured output (line ID → translation) so lines can be remapped to timings reliably rather than by position
- [ ] **Cached prefix: the §3.1 glossary**, which is per-video and stable for the whole run — an ideal cache prefix, reused across every chunk request
- [ ] Keep the glossary at the front and the per-chunk lines after the last cache breakpoint
- [ ] Verify with `usage.cache_read_input_tokens`; if it is zero across chunks, something in the prefix is varying
- [ ] Continuous chunk requests keep the default 5-minute TTL warm, so the 1.25× write is paid once per video and the 1-hour TTL buys nothing

### 3.5 Whole-transcript single pass — not available locally

Written for Gemini, whose context window fits a whole 7h53m transcript in one request. Not reachable on local Qwen at this hardware: the KV cache for a full 256K context will not fit in 12 GB of VRAM, so the local path stays chunked.

The related problem *is* solved, though. Pass 1 needs to see the whole video, and a 75,000-character transcript fits no local context — so it samples units evenly across the video rather than taking a prefix. On the 8-hour archive that reduced 5,039 units to 388 and still produced a usable glossary.

### 3.6 ~~Batch API~~ — moot

Written when the backend was a paid API, where batching halved the bill. A local model has no batch tier and no per-token cost, so there is nothing to trade latency for. Dropped.

---

## Stage 4 — Pipelining and Storage

### 4.1 Ahead-of-playhead scheduling — not built, deliberately

Superseded by measurement (§0.3). At 28× real time the whole video is translated before a viewer reaches the second minute, so prioritising around the playhead solves a problem that does not occur. Chunks are translated in order and pushed as they finish.

What was kept from the idea:

- [x] **Progressive delivery** — partial results reach the overlay after every chunk
- [x] **Cancel work the viewer has abandoned** — navigating the tab to another video stops the run at the next chunk boundary. Not for efficiency: without it the old run kept painting its subtitles onto the new video and kept the tab marked busy.
- [x] **Show progress honestly** — a progress box on the video and in the popup, with a remaining-time estimate

### 4.2 Result caching
- [x] **Stored per video id**, so a re-watch is instant and free
- [x] **Local browser storage only.** A shared backend would make repeat views free across users, but turns a personal tool into a service with hosting and raises questions about redistributing translations of third-party content. Out of scope by choice.
- [x] **Bounded, not permanent.** `chrome.storage.local` caps at 10 MB and a 4-hour VOD is ~417 KB of units, so an unbounded cache would start failing writes after about twenty. 7 MB budget, LRU eviction, usage shown in the popup.
- [x] **Versioned.** Entries record the pipeline version that made them; a segmentation or timing change discards stale ones. Without this a fix could never reach a video already watched, because the cache stores the timings it was made with.
- [ ] Export to `.srt` from the extension — the CLI does it, the extension does not

---

## Stage 5 — Rendering

### 5.1 Surface
- [ ] Overlay div in a shadow DOM, anchored to the YouTube player
- [ ] Survives fullscreen and theatre mode
- [ ] Hide during ads
- [ ] User-configurable position and appearance

### 5.2 Display logic
- [ ] Drive from the video's `currentTime`; resolve the active cue by timestamp so seeking works instantly
- [ ] Reading-speed sanity check (~20 chars/sec, max two lines) — English renderings of dense Japanese lines can overrun their cue
- [ ] Timing remap when translation merges or splits lines (§3.3)
- [ ] Minimum dwell time, so a rapid exchange does not flicker
- [ ] Optional dual display: Japanese source above the English translation

### 5.3 Styling
- [ ] Font, size, outline/shadow for legibility over video
- [ ] Do not collide with YouTube's own caption container

---

## Stage 6 — Cost, Fallback, and Failure

- [ ] Token accounting per video; validate against the §0.4 prediction
- [ ] Show estimated cost **before** translating a long archive — an eight-hour VOD is not a nine-cent anime episode
- [ ] Model selector, with per-video cost shown where the backend charges per token
- [x] **Backend: local Qwen3.5 through Ollama.** Gemini was the planned first choice but was never needed — Qwen cleared the quality bar on the first run. The Gemini backend exists in code and remains **unverified**. Setup: [docs/translation-backends.md](docs/translation-backends.md).
- [ ] This reverses the earlier decision to drop a second backend. That reasoning was cost-based and is now moot — the constraint is **access**, not price. Two real backends justify a thin seam between "produce translation units" and "call a model"; keep it to one function, not a plugin architecture.
- [ ] The quality result in [eval/README.md](eval/README.md) came from the **two-pass method**, not from any particular model. Re-run the fixtures against whichever backend ships before trusting it.

### 6.1 Degradation behaviour

- [ ] No Japanese caption track and ASR unavailable → say so plainly rather than failing silently
- [ ] `timedtext` returns an empty 200 (§1.1) → this is a **refusal, not an empty video**. Detect it explicitly, report it, and fall through to ASR. Never present it as success.
- [x] Ollama unreachable or refusing (403 on an unknown origin) → reported with the fix, not a bare status code
- [x] Analysis pass fails → degrade to an empty glossary and translate anyway. It used to abort the whole run, so one bad reply cost every subtitle.
- [ ] Translation falls behind the playhead → show the gap honestly
- [ ] Network drops mid-video → resume from the last completed chunk, never restart
- [ ] Never leave a stale subtitle on screen after a seek

---

## Stage 7 — Evaluation

- [ ] Reference set: ~10 minutes of Japanese video with human English subtitles, covering **both** profiles — one anime clip, one VTuber clip
- [ ] Build the reference set during build step 1 — it is the only way to tell whether a prompt change helped
- [ ] Score transcript-only and translation-only separately to isolate failures
- [ ] Track **pronoun-resolution accuracy** as its own metric — the failure mode most visible to a viewer (§3.3)
- [ ] Track **name and term consistency** across a whole video — the second most visible, and what §3.1 exists to fix
- [ ] **Baseline to beat: YouTube's own auto-translated English captions.** Observed during §1 testing — YouTube will auto-translate the Japanese ASR track to English natively, for free, with one click. That is the honest comparison, not "subtitles vs. no subtitles". If this project does not clearly beat it on pronoun resolution, names, and register, it has no reason to exist. Put it in the reference set as a scored competitor from day one.
- [ ] Compare inputs: does an auto-generated caption track plus a strong model beat proper ASR plus the same model?
- [ ] Compare models on the same transcript — the popup's model picker makes this easy to try
- [ ] Prompt version comparison harness

---

## Build Order

**All four steps complete.**

**Revised once, after the §1 testing.** The original plan had step 2 as a CLI taking a YouTube URL. That is not possible: caption content requires a `pot` token only obtainable from inside a live player session (§1.2). The extension shell therefore had to come earlier — and putting the riskiest part first paid off, since it worked on the first browser load.

1. ✅ **Extension shell — transcript extraction only.** Content script, main-world injection at `document_start`, enable the Japanese track, capture the `pot` URL, fetch the track, dump json3 to a file. No translation, no rendering. This is the risky part and it is now the first thing built, not the third.
2. ✅ **CLI translation core** — Japanese json3 (or `.srt`) in, English `.srt` out. Where §3 gets built: two-pass design, prompt, the Japanese handling in §3.3. Runs offline against files captured in step 1, so it iterates fast and costs nothing to re-run. Build the Stage 7 reference set here.
3. ✅ **Join them** — extension calls the translation core, renders over the player, handles seeking.
4. ✅ **Pipelining and polish** — result caching, per-channel glossary, progress and ETA, model picker. Ahead-of-playhead scheduling and cost display were dropped as unnecessary (§4.1, §0.4).

Since then: a per-channel glossary that seeds the analysis pass and is editable from the popup, and a bounded LRU cache with pipeline versioning.

---

## Questions — answered

- [x] **How reliable is third-party caption access?** Reliable enough, but not the way expected. Track *metadata* is freely readable; track *content* needs a proof-of-origin token minted by the player, and without it the endpoint returns **HTTP 200 with an empty body** — a silent refusal. The extension gets the player to mint one and rewrites the URL (§1.2).
- [x] **What fraction of videos have a usable Japanese track?** 20 sampled: **0 author-supplied**, 17 auto-generated, 3 none. Tier 1 does not exist for this content; the auto-generated track is the normal case, not a degraded one.
- [x] **Is punctuation restoration needed?** No. Japanese auto-captions are already punctuated — an assumption in the original design that was simply wrong.
- [x] **Progressive or blocking?** Progressive, though at 28× real time it barely matters (§0.3).
- [x] **Local-only cache or shared backend?** Local only, bounded to 7 MB with LRU eviction. A shared backend would turn a personal tool into a service.

## Questions — still open

- [ ] **How much forward context is enough for pronoun resolution?** Never measured. The current 10 before / 6 after was chosen, not derived.
- [ ] **Is pro-drop solvable at all here?** The one failure category still lost to YouTube. 「あ、寝ちゃった。」 → "I fell asleep" where the thing falling asleep is on screen and nowhere in the text. May need vision rather than more context.
- [ ] **Does the MV3 worker survive a multi-hour run?** A long translation is ~17 minutes of unbroken fetches. It has worked, but has never been deliberately stress-tested. If it fails, the fix is an offscreen document.
- [ ] **Are the quality claims real?** Everything in [eval/README.md](eval/README.md) was scored by the same party that produced one of the outputs, against a taxonomy that party wrote. A human reference translation would settle it.
- [ ] **Over-long subtitles.** 5.9% exceed two lines; Japanese expands 2–4× into English against 64-character source units. Prompt tuning was tried and measurably failed. Remaining levers are smaller units or accepting three lines.

---

## Appendix A — Deferred: Live Stream Pipeline

Preserved from the real-time design. Nothing here is in scope now; it is kept so the analysis is not lost if live streams come back.

**The shape.** Capture tab audio (`chrome.tabCapture` from an offscreen document, or `captureStream()` on the `<video>` element — unverified on YouTube's MSE player) → VAD endpointing → streaming ASR → translate → render.

**Latency budget that applied.** p50 ≤ 1.5 s, p95 ≤ 2.5 s, drop above 4 s, measured from end of utterance to painted subtitle. VAD endpointing (300–600 ms) dominates. Anchors: professional live captioning runs 3–5 s behind and simultaneous interpreters 2–4 s, so 1.5 s is already ahead of a human and sub-second buys nothing perceptible.

**Cost that applied.** Line-by-line requests, ~720 utterances/hour for anime and ~1,200 for VTuber streams: $0.40–0.67/hr on Haiku 4.5, $0.80–1.33 on Sonnet 5, $2.00–3.33 on Opus 5, plus $0.15–0.50/hr for hosted streaming ASR. Roughly 4× the VOD cost for the same content, because no request can share context with its neighbours.

**Findings worth keeping:**

- **Speculative translation does not work for Japanese.** It assumes a growing transcript prefix has stable meaning, but Japanese is verb-final: 食べます / 食べません / 食べたくなかった diverge only at the end, so a translated prefix is about as likely to be inverted as correct. If revisited, speculate on *clause completion*, not token-prefix stability.
- **Pro-drop is much harder live.** Without forward context the model can only guess from preceding lines — §3.2 is the VOD design's biggest single advantage.
- **Segmentation ownership must be decided once.** VAD splitting on silence and batching re-merging fragments are the same decision at two layers. An explicit segmenter stage between ASR and translation is probably right for Japanese, since acoustic silence and clause boundaries diverge often.
- **Japanese pause behaviour** (fillers, `〜ね`, `えっと`) trips aggressive endpointers and over-fragments clauses; start around 500 ms of trailing silence.
- **MV3 service workers die after ~30 s idle**, so a persistent capture session needs an offscreen document.
- **`tabCapture` mutes the tab** unless the stream is re-piped to an `AudioContext` destination.
- **Ads must pause capture**, or ad reads get transcribed and translated onto the screen.
