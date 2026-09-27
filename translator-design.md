# Japanese → English Subtitles for YouTube VOD

A browser extension that takes a YouTube video, obtains a Japanese transcript, translates it with a **local model through Ollama**, and renders English subtitles over the player.

> **Status: built and in use.** All four build steps are complete, plus a fifth (subtitle files). This document is now a record of the design and the reasoning behind it, updated to match what was actually built and measured. Where a prediction turned out wrong, the correction is kept alongside it rather than quietly replaced — the wrong predictions are the useful part.

### Progress at a glance

Reconciled against the code on 2026-09-27. A checkbox in the stages below means
*shipped*; `~~struck through~~` means dropped, with the reason kept.

| Stage | State |
|---|---|
| 0 — Scope | Settled. Two corrections recorded: Korean was mis-scoped (§0.1), and "transcript source" was drawn too widely (§0.2). |
| 1 — Transcript acquisition | **Built.** Gap: no ASR fallback for the ~15% of videos with no track. |
| 2 — Document preparation | **Built.** Three tiers collapsed to one, because author-supplied tracks do not exist for this content. |
| 3 — Translation | **Built.** Gaps: context window sizes never tuned; pro-drop unsolved. |
| 4 — Pipelining and storage | **Built.** Ahead-of-playhead scheduling deliberately dropped. |
| 5 — Rendering | **Built.** Gaps: no user styling, no dual JA/EN display. |
| 6 — Cost and failure | **Largely dissolved** — a local model has no cost. Gap: no resume after a dropped connection. |
| 7 — Evaluation | **Weakest stage.** Baseline comparison built; human reference parked on a Japanese reader; no prompt-version harness. |
| 8 — Korean | **Tested, not built.** Premise confirmed, costs measured. |

The honest summary: the *pipeline* is complete and the *evaluation* is not.
Every quality claim in this project is author-scored, and that is the single
largest outstanding weakness — not any missing feature.
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

> **Half right, and the wrong half was the expensive one.** Measured against a
> real Korean track in [eval/korean-findings.md](eval/korean-findings.md).
>
> Right: §3.3 does not transfer, and Korean needs its own prompt and its own
> evaluation.
>
> Wrong: this treated language as *only* a prompt question. It is not. The
> **mechanics** are coupled to Japanese in places nobody chose deliberately —
> the sentence-end class carries the fullwidth period but not the ASCII one
> Korean uses, `segment()` joins cues with no separator because Japanese has no
> spaces, and the language check added later scores hangul at zero. None of
> these were design decisions; they are Japanese leaking into code that reads
> as general. Each is a one-line fix, but only once someone looks.
>
> Also never asked: **does the premise transfer?** It does. YouTube's Korean →
> English is damaged in the same way and by a worse mechanism (§8).

### 0.2 Platform and content

- **Browser extension (Chrome, Manifest V3).**
- **YouTube VOD only** — archived anime and VTuber stream archives.

Write against YouTube directly. A generic "transcript source" interface, a pluggable player adapter, or a site-agnostic overlay would all be speculative generality here: there is one host page, one player, and one caption format. Couple to them and keep the code small.

> **Mostly held, with one cheap exception found later.** The player adapter and
> the site-agnostic overlay were correctly refused — neither was ever built and
> neither has been missed. But "transcript source" was drawn too widely. In
> 1.7.0 a `.srt`/`.vtt` **file** input reached every other site at once for the
> cost of a parser, because a subtitle file is already the shape the
> interceptor produces. It is not a pluggable source interface: it is one more
> concrete reader, and the output is a file rather than an overlay. The
> distinction the original note missed is between *abstracting* the source,
> which stays refused, and *adding* a second concrete one, which was nearly
> free.

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

**Built and working.** Most bullets below are *findings from testing*, not
outstanding work — they were written as checkboxes before the distinction
mattered and are left unticked because they are not tasks to complete. The one
genuine gap is the ASR fallback for videos with no track at all (§1.4), which
is not built and is the reason the tool says "no Japanese caption track"
rather than degrading to something else.

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

- [x] ~~Normalise all three tiers into one internal format~~ — **collapsed to one tier.** Of 20 videos sampled, 0 had an author-supplied track (§1.4), so the "three tiers" this was written for never materialised. Cues are `{t_ms, dur_ms, ja, segs?}` and there is only one producer of them — two, since 1.7.0 added the subtitle-file reader, which emits the same shape minus `segs`.
- [x] **Re-segment into translation units.** Built in `segment.js`, and it turned out to be the subtlest part of the project. Working at cue level cannot win, because the two content profiles need opposite treatment: cues are exploded into sentence pieces, then pieces accumulate until sentence-final punctuation, a 2 s silence, or a 64-character cap. One rule, both shapes — 131 cues → 78 units on a fragmented video (merging), 202 → 235 on a sentence-dense one (splitting).
- [x] **Sentence breaks land on real timestamps.** YouTube's json3 carries word-level timings (`tOffsetMs`) on roughly half of all cues, which the first implementation discarded and replaced with a character-count estimate. Switching to the real timings moved 22 of 78 unit starts, the worst by 4.3 s, and cut out-of-order units on a long video from **172 to 0**.
- [x] ~~Restore punctuation and sentence boundaries for Tier 2 input~~ — **not needed.** Japanese auto-captions arrive punctuated; the assumption behind this line was simply wrong (§1.3). It resurfaced for Korean, where the punctuation is present but uses the ASCII period the segmenter did not recognise (§8.2).
- [x] **Chunk into requests** — built in `chunk.js`. 20 units per request, 10 units of preceding and 6 of following context (§3.2). The window sizes were chosen rather than derived; that is still open.
- [x] **Chunk boundaries never land mid-clause** — free, and not by separate effort: chunking operates on units, and units are already sentence-bounded by §2's segmenter. The one time this was nearly lost was the rejected proposal to shrink source units, which would have raised mid-sentence splits from 324 to 466 (§Questions).

---

## Stage 3 — Translation

### 3.1 Two-pass design

Having the whole transcript up front makes a first pass possible, and it is where most of the quality comes from:

- [x] **Pass 1 — analysis (once per video).** Built. Also had to be *bounded*: the transcript is sampled evenly across the video down to 6,000 characters, because a four-hour archive is ~75,000 and an over-long prompt fails as a truncated, unparseable reply rather than a clear error. Sampling evenly rather than taking a prefix is what keeps names from the end of the video in the glossary.
- [x] **Pass 2 — translation (per chunk).** Built. The "cached prefix" framing did not survive the move to a local model — see §3.4.
- [x] Pass 1 pays for itself in consistency, as predicted. It also did something **not** predicted: it repairs ASR errors. 高感度イベント is a homophone of 好感度イベント and only one is meaningful in a farming sim — but you have to know it is a farming sim, which is exactly what pass 1 establishes.
- [x] **Pass 1 must never be load-bearing for the run.** Learned the hard way: a malformed reply used to throw and abort everything, so one bad JSON response cost every subtitle rather than just the glossary. It now retries three times, warns loudly, and translates with an empty glossary.
- [x] ~~Fold punctuation restoration into pass 1~~ — not needed; YouTube's Japanese ASR output is already punctuated (§1.3)

### 3.2 Context — the VOD advantage

Under the real-time design, context was a backwards-looking rolling window and pronoun resolution was guesswork. Here the model can see **ahead** as well as behind.

- [x] **Include following lines as well as preceding ones** — built; the prompt labels them explicitly as context not to be translated, and says *why* they help, which the model otherwise ignores
- [x] This is the single biggest quality win available for Japanese, and it held. It is what separates this from YouTube's per-cue translation, and it is the direct cause of the polarity-inversion category being fixed here and broken there.
- [ ] **Tune the window sizes.** Still not done. 10 before / 6 after was chosen, not derived, and has never been varied against a fixture.

### 3.3 Japanese-specific translation problems

These remain the top quality risks.

**Every one of these is now a numbered rule in `prompt.js`, each traceable to a
failure category measured on YouTube's output. They did not all work equally.**

- [ ] **Pro-drop.** Japanese omits subjects constantly, and unlike Spanish there is no verb agreement to recover person from. 「行った」 is "I / you / he / she / they went" with no marking at all. **Rule written, problem not solved.** This is the one category still lost to YouTube: 「あ、寝ちゃった。」 → "I fell asleep" where the thing that fell asleep is on screen and nowhere in the text. Forward context helps and is not sufficient — the referent is often visual. May need vision. Korean gets a partial answer for free (§8.3).
- [x] **Recover person from honorifics.** Taught explicitly in the prompt: 「くれる」 (someone did it for me) vs 「あげる」 (I did it for someone), humble forms marking the speaker, honorific forms the addressee. Resolves pronouns that surrounding lines cannot.
- [x] **Verb-final word order (SOV).** The rule tells the model that if a line's meaning depends on a clause finishing in a later line, the pair must read correctly together and must never assert the opposite. This is the fix for the single worst baseline failure — YouTube stating the negation of what was said (§7).
- [x] **Role language (役割語).** Attempted via the §3.1 register field rather than per-pronoun mapping. Honestly: the least verifiable thing here. Whether characterisation survives is exactly the judgement an author-scored evaluation cannot make.
- [x] **Register.** Captured as a per-video field in pass 1 and carried into every chunk, so it is at least *consistent* across a video, which was the failure worth preventing.
- [x] **Sentence-boundary mismatch.** Merging and splitting allowed, with timings remapped from word-level data (§5.2). Solved at the renderer rather than the pipeline — display-time splitting took over-84-character lines from 5.9% to 0.1%, where shrinking source units was measured and rejected.

### 3.4 Request design and caching

- [x] **System prompt: domain, register, output format constraints; suppress preamble and commentary.** Built, and the output-format constraints needed to be far harsher than anticipated — pass 1 once returned 22,129 characters of what was effectively a full translation instead of a reference sheet. Hard caps on entry counts and total length took it to 981 characters and cut the run time 24.5 s → 18.3 s.
- [x] **Return structured output (line ID → translation)** so lines remap by ID, never by position. Since extended to *copy-then-translate*: the model echoes each line's Japanese before its English, which stops translations sliding onto neighbouring lines on fragmented speech.
- [x] ~~Cached prefix: the §3.1 glossary~~ / ~~keep it before the last cache breakpoint~~ / ~~verify with `usage.cache_read_input_tokens`~~ / ~~5-minute TTL warmth~~ — **all four dropped, moot.** These are Anthropic prompt-caching mechanics and there is no such API in the local path. The glossary is still sent with every chunk; it is simply re-read each time, and at local-inference speeds that costs nothing worth optimising. Kept here because the *reasoning* was sound for the design it was written against.

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
- [x] Export to `.srt` from the extension, so a translation is not trapped in the browser

---

## Stage 5 — Rendering

**Built, and the hardest stage to get right.** Rendering was written once and
did not work at all on the first real run — four separate defects, none of
which produced an error. See the note at the end of this stage.

### 5.1 Surface
- [x] Overlay div in a shadow DOM, anchored to the YouTube player
- [x] Survives fullscreen and theatre mode — free, because the overlay is anchored to the *player* element rather than the page, and that is what goes fullscreen
- [x] Hide during ads — ads play in the same `<video>`, so without this an ad read gets subtitled
- [ ] **User-configurable position and appearance.** Not built. Nobody has asked, and the defaults have not been a complaint.

### 5.2 Display logic
- [x] Drive from the video's `currentTime`; resolve the active cue by timestamp so seeking works instantly. Binary search over a sorted list; a seek costs nothing and cannot strand a stale cue
- [x] Reading-speed sanity check — dwell scales with text length between a 500 ms floor and a 6 s ceiling
- [x] Timing remap when translation merges or splits lines (§3.3) — sentence splits anchored to YouTube's word-level `tOffsetMs`, which moved 22 of 78 unit starts and took out-of-order units on a long video from 172 to 0
- [x] Minimum dwell time, so a rapid exchange does not flicker
- [ ] **Optional dual display: Japanese above English.** Not built. The overlay never receives the Japanese — only `{t_ms, end_ms, en}` reaches it — so this is a cache-shape change, not a rendering one.

### 5.3 Styling
- [x] Font, size, outline/shadow for legibility over video
- [x] Do not collide with YouTube's own caption container — the progress box sits top-right, clear of the subtitle band, and YouTube's own captions are switched back off after being borrowed

> **Written, then found not to work — the most useful failure in the project.**
> The first run produced no subtitles and no errors. Four defects at once: a
> `requestAnimationFrame` loop that fired zero times per second because the tab
> was considered idle, an early return on a stale cue, silently dropped units,
> and swallowed delivery errors. The render loop is now a plain 100 ms
> `setInterval`, and `send()` reports undeliverable messages instead of
> discarding them. The lesson that stuck: **every one of these reported
> success.** Silent success is the failure mode this codebase has to be
> designed against, and it is why the empty-200 guard (§1.1) and the
> analysis-pass warning (§3.1) exist in the form they do.

---

## Stage 6 — Cost, Fallback, and Failure

**This whole stage was largely dissolved by moving to a local model.** Cost
accounting is the bulk of it, and there is no cost.

- [x] ~~Token accounting per video~~ — **dropped, moot.** Local inference is free; the only budget is time, and the ETA covers it.
- [x] ~~Show estimated cost before translating a long archive~~ — **dropped, moot**, same reason. Replaced by a remaining-time estimate, which is the scarce resource now.
- [x] **Model selector** — built. The per-video cost half is moot; the picker itself turned out to matter for a different reason, as the only real speed lever on weak hardware.
- [x] **Backend: local Qwen3.5 through Ollama.** Gemini was the planned first choice but was never needed — Qwen cleared the quality bar on the first run. The Gemini backend exists in code and remains **unverified**. Setup: [docs/translation-backends.md](docs/translation-backends.md).
- Note, not a task: this reversed the earlier decision to drop a second backend. That reasoning was cost-based and is now moot — the constraint is **access**, not price. The seam stayed one function per backend rather than a plugin architecture, and that has held.
- [ ] The quality result in [eval/README.md](eval/README.md) came from the **two-pass method**, not from any particular model. Re-run the fixtures against whichever backend ships before trusting it. **Still outstanding** — only Qwen3.5 has ever been scored.

### 6.1 Degradation behaviour

- [x] No Japanese caption track → said plainly. There is no ASR fallback to be unavailable, so the message states the real limit rather than implying a retry.
- [x] `timedtext` returns an empty 200 (§1.1) → detected explicitly and reported as a **refusal, not an empty video**. The "fall through to ASR" half was **dropped**: no ASR path was ever built, so the honest behaviour is to say the track cannot be read.
- [x] Ollama unreachable or refusing (403 on an unknown origin) → reported with the fix, not a bare status code
- [x] Analysis pass fails → degrade to an empty glossary and translate anyway. It used to abort the whole run, so one bad reply cost every subtitle.
- [x] ~~Translation falls behind the playhead~~ → **dropped, moot.** At 28× real time the playhead never catches up. It is the opposite problem on CPU-only machines, where the whole run finishes before playback starts being worth it — handled by reporting progress honestly, not by tracking a gap.
- [ ] **Network drops mid-video → resume from the last completed chunk.** Not built, and the current behaviour is deliberate rather than accidental: a partial translation is never cached, because a half-finished run that looks complete on the next visit is worse than one that plainly failed. Resuming properly needs a partial-cache shape that records *which* chunks are done. The retry logic inside a chunk (two re-asks for missing lines) covers the common case; a dropped connection mid-run does not.
- [x] Never leave a stale subtitle on screen after a seek — falls out of resolving the cue from `currentTime` every tick rather than advancing a cursor

---

## Stage 7 — Evaluation

**The weakest stage, and knowingly so.** The baseline comparison was built and
is the spine of [eval/README.md](eval/README.md). The human reference — the
thing that would make any of it independent — was not, and everything
downstream of it is still open.

- [ ] **Reference set: ~10 minutes with human English subtitles, both profiles.** **Parked, blocked on a Japanese reader.** Attempted and abandoned for a good reason: a reference supplied by the same party that produced one of the outputs is circular even after correction, so a wrong reference is worse than none. Kept in [eval/reference/](eval/reference/).
- [x] ~~Build the reference set during build step 1~~ — did not happen, and the ordering advice was sound: prompt changes since have been justified by fixture diffs and counting, not by a score.
- [ ] Score transcript-only and translation-only separately — not done
- [ ] Track **pronoun-resolution accuracy** as its own metric — exists as a category in the taxonomy, not as a measured number
- [ ] Track **name and term consistency** across a whole video — same: described, not counted. §3.1 is justified by the failure it prevents, not by a metric.
- [x] **Baseline to beat: YouTube's own auto-translated English captions.** Built, and it is the one part of this stage that worked as intended. A 131-cue window with YouTube's English aligned 1:1, and a seven-category failure taxonomy drawn from it. **Caveat that must travel with every number:** scored in-house, against a taxonomy written by the same party that produced one of the outputs.
- [x] ~~Compare inputs: auto-captions plus a strong model vs. proper ASR plus the same model~~ — **dropped.** Moot for the shipped tool, which has no ASR path (§6.1). It would be a question about a different product.
- [ ] Compare models on the same transcript — the picker makes it easy, and it still has not been done. Only Qwen3.5 has been scored.
- [ ] Prompt version comparison harness — not built. Prompt changes are currently justified by running fixtures and reading the diff by hand, which caught the pass-1 runaway (22,129 chars → 981) but does not scale.

> **What the evaluation actually rests on.** Strip out what is unmeasured and
> the honest claim is narrow: against one competitor, on two fixtures, scored
> by the author. The structural findings are solid because they are counted —
> unit lengths, out-of-order units, over-long lines, cue-boundary splits. The
> *quality* claims are not independent and are labelled as such wherever they
> appear. Korean (§8) is in better shape on this axis by accident: much of
> YouTube's damage there is visible in the English alone.

---

## Stage 8 — Language Expansion: Korean

**Status: tested, not built.** Measured 2026-09-27 against a 147-minute
StelLive VOD. Full numbers in [eval/korean-findings.md](eval/korean-findings.md);
the code-readiness probe is [eval/korean-readiness.mjs](eval/korean-readiness.mjs).

The rule applied here was *test the premise before writing anything*, and it
paid for itself twice: once by killing the assumption that Korean was only a
prompt change, and once by finding an advantage Japanese does not have.

### 8.1 The premise transfers, by a worse mechanism

YouTube's Korean → English is damaged in the same family of ways as its
Japanese, but the mechanism differs. Japanese cues were translated
*independently*, stranding polarity in the next cue. Korean looks like a cue
pair translated *jointly* and then re-split by character position — which
severs words outright. A cue ends `...first of all, do` and the next begins
`n't dress hip...`; six such splits in ten minutes.

That is §3.3's polarity hazard made worse: in Japanese the negation was in the
next cue, here it is mid-token. It is also legible **without reading Korean**,
which matters given §7's unresolved dependency on a human reader.

### 8.2 Korean is a patch, not a redesign

The question that decided this was whether Korean ASR punctuates at all. It
does — **41.5% of cues end in terminal punctuation against 31.3% for
Japanese**. Sentence-level segmentation has *more* to work with, not less.

Adding the ASCII period to the sentence-end class is one character and moves
the median subtitle from 9.0 s on screen to 4.4 s.

### 8.3 Korean has speaker markers, and Japanese does not

**53% of Korean cues begin with `>>`**, the captioning convention for a speaker
change. The Japanese track has none.

This contradicts a claim made publicly in the README — that YouTube's
recognition yields one undifferentiated stream with no speaker labels. True of
Japanese, false here, and it must be qualified by language.

It marks a turn boundary, not an identity. But turn boundaries are most of what
pro-drop needs, and pro-drop is the one category still lost to YouTube
(§Questions). **Korean may end up better served than Japanese on the problem
Japanese cannot solve without vision.**

### 8.4 What it would cost

| Change | Size | State |
|---|---|---|
| ASCII period in `SENTENCE_END` / `SENTENCE_SPLIT` | one character each, plus a `(?!\d)` guard so `3.5` does not split | ✅ 1.8.0 |
| Join cues with a space for spaced languages | `core/script.js` | ✅ 1.8.0 |
| Hangul detection | `core/script.js` | ✅ 1.8.0 |
| Strip `>>` and use it as a turn boundary | `segment()`; units now carry `turn` | ✅ 1.8.0 |
| Re-tune `maxChars` for Korean density | **measured, not needed** — the 64-char cap binds on 0.7% of Korean units against 6.4% of Japanese ones | ✅ |
| Language plumbing | `core/languages.js`; interceptor selects by priority | ✅ 1.9.0 |
| Korean prompt replacing the §3.3 rules | **the actual work** | ⬜ |
| Korean evaluation set | blocked on a Korean reader | ⬜ |

### 8.6 Extraction and translation are separate capabilities

Step 2 turned one question into two, and the split is the useful part.

**Extraction is language-agnostic and always was.** The rewrite in §1.2 works
because `sparams` does not cover `lang`; nothing about that is Japanese. Once
the hardcoded `"ja"` came out, Korean extraction worked with no new mechanism —
the same signed URL, pointed somewhere else. Korean transcripts can now be
pulled with **Save transcript only**, which is how the remaining Korean
fixtures should be collected rather than fighting yt-dlp's rate limits.

**Translation is not**, because it needs a prompt written against a specific
language's failure modes. So `languages.js` carries two flags, not one, and
Korean is `extract: true, translate: false`. A Korean video now reports
*"Korean, auto-generated — cannot be translated yet"* instead of the old
*"no Japanese caption track"*, which was true and useless.

**What was deliberately not done:** threading a language parameter into
`prompt.js`. There is exactly one value it could take today, and §0.2's warning
about speculative generality applies to the language axis as much as the
source axis. It gets threaded in step 3, when there is a second value.

`segment.js` needed no language parameter at all — after step 1 its spacing
decision is per-character, so it adapts on its own.

**Result of step 1**, measured on the committed fixtures:

| | Korean before | Korean after | Japanese |
|---|---|---|---|
| Units | 1,238 | 3,580 | unchanged |
| Median time on screen | 9.0 s | 4.1 s | unchanged |
| Units over 12 s | 207 | 18 | unchanged |
| Turn-marked units | — | 2,050 | n/a |

> **The near-miss worth recording.** The first version of the spacing rule
> added a space unless *both* sides were no-space script. Unit counts stayed
> at exactly 78 and 235, so the Japanese regression check passed — and the
> text had changed anyway: 「もう1回」 became 「もう 1回」, 「YouTubeで」 became
> 「YouTube で」. Japanese embeds ASCII without spaces, so one side being kana
> or Han is enough to mean "no space here". Nine units across the two
> fixtures, invisible to a count-based check. The test suite now asserts on
> content, not just cardinality.

### 8.5 Chinese is not next

Nothing here transfers to Chinese. It is SVO, has no honorific system, and the
§3.3 categories largely do not apply. Korean is cheap *because* it is
structurally close to Japanese; Chinese is not, and would be a separate design.

---

## Build Order

**All four steps complete.**

**Revised once, after the §1 testing.** The original plan had step 2 as a CLI taking a YouTube URL. That is not possible: caption content requires a `pot` token only obtainable from inside a live player session (§1.2). The extension shell therefore had to come earlier — and putting the riskiest part first paid off, since it worked on the first browser load.

1. ✅ **Extension shell — transcript extraction only.** Content script, main-world injection at `document_start`, enable the Japanese track, capture the `pot` URL, fetch the track, dump json3 to a file. No translation, no rendering. This is the risky part and it is now the first thing built, not the third.
2. ✅ **CLI translation core** — Japanese json3 (or `.srt`) in, English `.srt` out. Where §3 gets built: two-pass design, prompt, the Japanese handling in §3.3. Runs offline against files captured in step 1, so it iterates fast and costs nothing to re-run. Build the Stage 7 reference set here.
3. ✅ **Join them** — extension calls the translation core, renders over the player, handles seeking.
4. ✅ **Pipelining and polish** — result caching, per-channel glossary, progress and ETA, model picker. Ahead-of-playhead scheduling and cost display were dropped as unnecessary (§4.1, §0.4).

Since then: a per-channel glossary that seeds the analysis pass and is editable from the popup, and a bounded LRU cache with pipeline versioning.

5. ✅ **Subtitle files** (1.7.0). `.srt`/`.vtt` in, English `.srt` out, in its own tab. Reaches video outside YouTube for the cost of a parser, because a subtitle file is the same timed-cue shape the interceptor already produces (§0.2). The run lives in the page rather than the service worker, which removes the MV3 lifetime question from that path.

### Next

6. ⬜ **Korean** (§8). Tested, not built. The mechanical fixes are measured and small; the prompt is the real work. Order within it: the one-character segmentation fixes and hangul detection first, since they are provable against the committed fixture; the prompt second; the evaluation set last, because it is the part that blocks on a reader.

Not planned: Chinese (§8.5), a pluggable transcript-source interface (§0.2), ahead-of-playhead scheduling (§4.1), live streams (Appendix A).

---

## Questions — answered

- [x] **How reliable is third-party caption access?** Reliable enough, but not the way expected. Track *metadata* is freely readable; track *content* needs a proof-of-origin token minted by the player, and without it the endpoint returns **HTTP 200 with an empty body** — a silent refusal. The extension gets the player to mint one and rewrites the URL (§1.2).
- [x] **What fraction of videos have a usable Japanese track?** 20 sampled: **0 author-supplied**, 17 auto-generated, 3 none. Tier 1 does not exist for this content; the auto-generated track is the normal case, not a degraded one.
- [x] **Is punctuation restoration needed?** No. Japanese auto-captions are already punctuated — an assumption in the original design that was simply wrong.
- [x] **Progressive or blocking?** Progressive, though at 28× real time it barely matters (§0.3).
- [x] **Local-only cache or shared backend?** Local only, bounded to 7 MB with LRU eviction. A shared backend would turn a personal tool into a service.

## Questions — still open

- [ ] **How much forward context is enough for pronoun resolution?** Never measured. The current 10 before / 6 after was chosen, not derived.
- [ ] **Is pro-drop solvable at all here?** The one failure category still lost to YouTube. 「あ、寝ちゃった。」 → "I fell asleep" where the thing falling asleep is on screen and nowhere in the text. May need vision rather than more context. **In Korean it may be partly free:** 53% of cues carry a `>>` speaker-change marker (§8.3), which is a turn boundary the Japanese track never provides.
- [ ] **Does the MV3 worker survive a multi-hour run?** A long translation is ~17 minutes of unbroken fetches. It has worked, but has never been deliberately stress-tested. If it fails, the fix is an offscreen document.
- [ ] **Are the quality claims real?** Everything in [eval/README.md](eval/README.md) was scored by the same party that produced one of the outputs, against a taxonomy that party wrote. A human reference translation would settle it. Korean inherits this exactly, and the Korean work should not wait on it — §8's findings are all countable.
- [ ] **Does a `>>` turn boundary actually improve pro-drop?** Korean supplies one for free (§8.3). Whether feeding it to the model helps is unmeasured, and it is the most interesting question the Korean work opens.
- [x] **Over-long subtitles.** Solved at the renderer, not in the pipeline. 5.9% of lines exceeded two lines; they are now split into sequential display cues across the unit's own span, taking over-84-character lines to 0.1% with no text lost. Shrinking source units was measured and rejected: ~3% slower, but mid-sentence splits rise from 324 to 466, reinventing the polarity failure this project's advantage rests on. Prompt tuning was tried earlier and measurably failed.

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
