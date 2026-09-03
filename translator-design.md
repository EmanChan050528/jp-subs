# Japanese → English Subtitles for YouTube VOD

A browser extension that takes a YouTube video, obtains a Japanese transcript, translates it with the Claude API, and renders English subtitles over the player.

**Scope note:** this is the VOD-only design. Live streams are deferred — the real-time pipeline is preserved in [Appendix A](#appendix-a--deferred-live-stream-pipeline) so it can be picked up later.

**Key constraint:** the Claude API does not accept audio input. Where YouTube already provides a Japanese caption track there is no speech recognition stage at all; where it does not, ASR is a fallback that runs offline over the audio.

**What VOD buys us.** No latency budget, no VAD, no streaming ASR, no speculative translation, no backpressure. In exchange we get the whole transcript up front — which is the single largest quality win available for Japanese (see §3.2), and cuts cost by roughly 4× (see §0.4).

---

## Stage 0 — Scope and Targets

### 0.1 Languages

- **Source: Japanese.** Chinese and Korean are possible later additions.
- **Target: English.**
- [ ] Keep the translation system prompt per-source-language (the JA prompt will not transfer to CN — see §3.3)

### 0.2 Platform and content

- **Browser extension (Chrome, Manifest V3).**
- **YouTube VOD only** — archived anime and VTuber stream archives. Live streams deferred; non-YouTube audio deferred.
- [ ] Keep transcript acquisition behind an interface so a second source can be added without touching the rest of the pipeline

Because everything runs offline relative to playback, the MV3 service-worker lifetime problem mostly disappears: work is request-shaped and short-lived rather than a persistent capture session. Confirm this holds for long VTuber archives, where a single video's translation may take minutes.

#### YouTube host-page constraints

- [ ] **Anchor the overlay to the player**, not the page — it gets theatre mode and fullscreen for free
- [ ] **Handle seeking.** The user can jump anywhere in the video at any time; the renderer must resolve a cue for an arbitrary timestamp instantly, which means the translation should be stored as a complete timed list, not a stream.
- [ ] Ads interrupt playback but not our data — the overlay must hide during ad playback rather than showing a cue at the wrong time
- [ ] **Overlay isolation.** Inject into a shadow DOM so host-page CSS and CSP cannot break the subtitles.
- [ ] **API key handling.** An API key shipped inside an extension is public. Either proxy through a relay backend, or require users to supply their own key. Decide before Stage 3.

### 0.3 Timing targets

Latency is no longer a per-utterance figure. Two targets replace it:

| Target | Value |
|---|---|
| Time to first subtitle (user presses play → subtitles start) | ≤ 15 s |
| Translation stays ahead of the playhead by | ≥ 60 s |
| Full 24-minute episode translated | ≤ 90 s |

The design that satisfies these is **translate-ahead-of-playhead**: translate the first couple of minutes, start rendering, and keep working forward faster than real time. Full-video-then-play is simpler but makes the user wait; progressive is barely harder and feels instant.

- [ ] Decide: progressive (translate ahead of playhead) or blocking (translate all, then play)
- [ ] Handle a seek past the translated region — show a brief "translating…" state rather than nothing

### 0.4 Cost

Costs collapse under VOD for three compounding reasons: the caption track makes ASR free, whole-document processing lets many lines share one request, and the Batch API halves what remains.

Assumptions: ~20 subtitle lines per request with ~10 lines of preceding context; 1,500-token cached prefix (system prompt + glossary); ~25 tokens per Japanese line in, ~20 tokens per English line out.

| Model | In / Out per MTok | Per request | Anime episode (~24 min, ~290 lines) | VTuber archive (~4 h, ~5,000 lines) |
|---|---|---|---|---|
| Haiku 4.5 | $1 / $5 | $0.0029 | $0.04 | $0.73 |
| Sonnet 5 | $2 / $10 | $0.0058 | $0.09 | $1.45 |
| Opus 5 | $5 / $25 | $0.0145 | **$0.22** | $3.63 |

Halve the right-hand columns again if the Batch API is used (see §3.5).

**This changes the model recommendation.** Under the real-time design, Opus 5 was ruled out at $2–3.33/hour. Here a full anime episode on Opus 5 costs about **22 cents** — roughly $0.55/hour of video, comfortably inside the old $1.00/hour ceiling that Sonnet 5 was breaking. Quality is now affordable.

Revised targets:

| Target | Value |
|---|---|
| Ceiling | $0.25 per hour of video |
| Target | $0.10 per hour of video |

- [ ] **Proposed default: Sonnet 5**, with Opus 5 as a "best quality" option that costs cents per episode and Haiku 4.5 as a bulk/batch mode. Confirm against real quality data in Stage 7 rather than assuming it now.
- [ ] Long VTuber archives are still the expensive case — that is where batching and Haiku earn their place
- [ ] Cache the finished translation per video ID so a re-watch costs nothing (§4.2)

---

## Stage 1 — Transcript Acquisition

The stage that replaces live capture. Three tiers, in order of preference.

### 1.1 Tier 1 — Author-supplied Japanese caption track

The best case: accurate text, punctuated, sensibly segmented, with timings already aligned to speech. Free.

- [ ] Detect whether the video has a Japanese track, and whether it is author-supplied or auto-generated
- [ ] **Access is the hard part.** The YouTube Data API's `captions.download` only works for videos the authenticated user *owns*, so it is unusable for third-party videos. The practical route is the same `timedtext` endpoint the player itself uses — which is undocumented and can change without notice.
- [ ] Treat this as a **fragility risk, not a solved problem**: wrap it behind an interface, detect failure explicitly, and fall through to Tier 3 rather than breaking.

### 1.2 Tier 2 — Auto-generated Japanese caption track

Available on most videos, including many VTuber archives, but materially worse:

- [ ] **No punctuation and no sentence boundaries.** Japanese auto-captions arrive as an unpunctuated stream, which is a serious problem for a language where clause boundaries carry the grammar. A pre-pass is needed to restore sentence segmentation before translation — a good job for Claude (§3.1).
- [ ] Segmentation is timing-driven, not linguistic — cues break mid-clause
- [ ] Recognition errors on names, slang, and net-speak, which is exactly the VTuber vocabulary
- [ ] Quality-gate before trusting it; decide when to fall through to Tier 3 instead

### 1.3 Tier 3 — ASR fallback

For videos with no usable Japanese track.

- [ ] Extract audio, run recognition offline (no streaming constraint — accuracy is the only axis that matters now, so the largest practical model wins)
- [ ] Local option: faster-whisper / whisper.cpp, or WASM in-browser
- [ ] Hosted option: whichever engine benchmarks best on Japanese
- [ ] **Benchmark on VTuber audio, not clean anime dialogue** — that is the hard case
- [ ] Detect singing and music-only stretches and suppress rather than transcribe; hallucinated lyrics are worse than a blank overlay
- [ ] This tier reintroduces cost and processing time — surface both to the user before running it

### 1.4 Content profiles

| | Anime | VTuber archive |
|---|---|---|
| Speech | Scripted, clearly enunciated | Unscripted, fast, overlapping, heavy fillers |
| Lines | ~290 per episode | ~5,000 per 4-hour archive |
| Register | Wide, deliberate role language (役割語) | Casual, slang, net-speak, in-jokes |
| Vocabulary | Fixed per series | Fixed per streamer, plus fast-moving memes |
| Caption tracks | Often author-supplied | Usually auto-generated only |
| Likely tier | 1 | 2, sometimes 3 |

- [ ] **Chat reading.** Streamers read Japanese superchats aloud, switching register and referent mid-sentence with no cue. Expect pronoun resolution (§3.3) to fail hardest here.
- [ ] Role language matters more for anime, slang and memes more for VTubers — likely two system prompts, not one

---

## Stage 2 — Document Preparation

- [ ] Normalise all three tiers into one internal format: a list of `{start, end, text}` cues
- [ ] **Re-segment into translation units.** Caption cues are timed for reading, not for grammar; a Japanese clause routinely spans two cues. Merge cues into complete sentences before translation, and keep a mapping back to the original timings.
- [ ] Restore punctuation and sentence boundaries for Tier 2 input (§1.2)
- [ ] Chunk into requests: ~20 lines per request with ~10 lines of preceding overlap for context
- [ ] Decide chunk boundaries on sentence boundaries, never mid-clause

---

## Stage 3 — Translation with Claude

### 3.1 Two-pass design

Having the whole transcript up front makes a first pass possible, and it is where most of the quality comes from:

- [ ] **Pass 1 — analysis (once per video).** Read the full transcript and extract: character names and how they are written, speaker roles and relationships, recurring terms and in-jokes, register per speaker, and the domain. Output a compact glossary.
- [ ] **Pass 2 — translation (per chunk).** Translate with that glossary as the cached prefix.
- [ ] Pass 1 costs one request over a long input and pays for itself immediately in consistency — the same name rendered three different ways across an episode is the most obvious tell of a machine translation.
- [ ] For Tier 2 input, fold punctuation restoration into pass 1

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

### 3.5 Batch API

Chunk translation is embarrassingly parallel and not latency-critical for the blocking design — a natural fit for the Batch API at 50% cost.

- [ ] Incompatible with translate-ahead-of-playhead (§0.3), which needs results promptly
- [ ] Likely both: synchronous for "translate this now", batch for "queue this for later" or bulk pre-translation of a series
- [ ] Decide after §0.3 is settled

---

## Stage 4 — Pipelining and Storage

### 4.1 Ahead-of-playhead scheduling
- [ ] Translate forward from the playhead, prioritising the next chunk the viewer will reach
- [ ] Re-prioritise on seek
- [ ] Cancel or deprioritise work the viewer has skipped past
- [ ] Show progress honestly — a stalled pipeline must not look like a silent passage

### 4.2 Result caching
- [ ] Store completed translations keyed by video ID (and caption-track version) so a re-watch is free
- [ ] Decide where: local browser storage only, or a shared backend
- [ ] A shared backend makes repeat views free across users but turns this into a service with hosting, and raises questions about redistributing translations of third-party content — a product decision, not a technical one
- [ ] Allow export to `.srt`

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
- [ ] Show estimated cost **before** translating a long archive — a 4-hour VTuber VOD is not a 22-cent anime episode
- [ ] Model selector: Haiku 4.5 / Sonnet 5 / Opus 5, with per-video cost shown
- [ ] Local model fallback (Gemma, Qwen) behind the same interface

### 6.1 Degradation behaviour

- [ ] No Japanese caption track and ASR unavailable → say so plainly rather than failing silently
- [ ] `timedtext` access breaks (§1.1) → detect and fall through to Tier 3, do not present an empty transcript as success
- [ ] Claude API returns 429 → back off; the viewer keeps watching, so degrade to "translating…" rather than stalling playback
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
- [ ] Compare tiers: does Tier 2 (auto-captions) plus a strong model beat Tier 3 (good ASR) plus the same model?
- [ ] Compare models on the same transcript — Opus 5 costs cents per episode here, so the quality question is worth settling properly
- [ ] Prompt version comparison harness

---

## Build Order

1. **CLI, file-based** — a Japanese `.srt` in, an English `.srt` out. No extension, no YouTube, no player. Get §3 right here: the two-pass design, the prompt, and the Japanese handling in §3.3. Build the Stage 7 reference set in this step.
2. **Transcript acquisition** — add Tier 1/2 fetching so a YouTube URL in produces an English `.srt` out. Still a CLI. Add Tier 3 only if the coverage gap demands it.
3. **Extension** — wrap step 2 in the extension, render the result over the player, handle seeking.
4. **Pipelining and polish** — ahead-of-playhead scheduling, result caching, cost display, batch mode.

Steps 1 and 2 are each independently useful, which is the main reason to prefer VOD first.

---

## Open Questions

- [ ] How reliable is third-party caption access in practice (§1.1)? This gates the whole design — if `timedtext` is not dependable, Tier 3 ASR becomes the primary path rather than the fallback, and the cost model changes. **Answer this first; it is cheap to test.**
- [ ] What fraction of target videos actually have a usable Japanese track? Sample real anime and VTuber archives before assuming Tier 1 coverage.
- [ ] Does Tier 2 plus punctuation restoration beat Tier 3 ASR? Determines whether ASR is needed at all.
- [ ] Progressive or blocking translation (§0.3)? Decides whether the Batch API is usable.
- [ ] Local-only result cache, or a shared backend (§4.2)?
- [ ] How much forward context is enough for pronoun resolution now that it is available (§3.2)?

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
