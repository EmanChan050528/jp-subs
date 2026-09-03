# Real-Time Voice Translation Subtitles

A pipeline that captures live audio, transcribes it with a speech recognition model, translates the text with the Claude API, and renders the result as overlay subtitles.

**Key constraint:** the Claude API does not accept audio input. Speech recognition and translation are two separate stages, and the boundary between them is where most of the interesting engineering lives.

---

## Stage 0 — Scope and Targets

### 0.1 Languages

- **Source: Japanese (priority).** Chinese and Korean are possible later additions, but every decision below is made for Japanese first.
- **Target: English.**
- [ ] Keep the ASR engine choice language-pluggable so CN/KR can be added without a rewrite
- [ ] Keep the translation system prompt per-source-language (the JA prompt will not transfer to CN — see §3.5)

### 0.2 Platform

- **Browser extension (Chrome, Manifest V3).** Audio comes from `chrome.tabCapture`; subtitles render as an injected overlay.
- This removes most of §1.1 (no OS loopback drivers) and §5.1 (no Electron/Tauri window), at the cost of being limited to tab audio.
- [ ] Confirm the extension can be MV3-only, or whether a desktop build is a later target

#### Extension-specific constraints (decide before Stage 1)

- [ ] **MV3 service worker termination.** The worker is killed after ~30s idle, which would drop the capture and the ASR WebSocket mid-session. Persistent audio work has to live in an **offscreen document**, not the service worker.
- [ ] **`tabCapture` re-routes audio.** Capturing mutes the tab unless the stream is piped back to an `AudioContext` destination. Must be handled or the user loses their audio.
- [ ] **Requires a user gesture** per tab to start capture — affects the activation UX.
- [ ] **DRM-protected media.** Widevine-protected audio (Netflix, Disney+, etc.) may not be capturable. Confirm early; it decides whether the extension works on the content the user actually wants.
- [ ] **API key handling.** An API key shipped inside an extension is public. Either proxy requests through a relay backend, or require users to supply their own key. This is an architecture decision, not a detail — pick one before Stage 3.
- [ ] **Overlay isolation.** Inject into a shadow DOM so host-page CSS and CSP cannot break the subtitles, and so the overlay survives the page's own fullscreen video container.

### 0.3 Latency budget

Measured from **end of the spoken utterance** to **subtitle painted on screen**.

| Target | Value |
|---|---|
| p50 | ≤ 1.5 s |
| p95 | ≤ 2.5 s |
| Hard drop | > 4.0 s — discard the line rather than fall further behind |

Predicted breakdown (browser extension + hosted streaming ASR):

| Stage | Typical | Notes |
|---|---|---|
| `tabCapture` → AudioWorklet → resample to 16 kHz | 20–50 ms | negligible |
| **VAD endpointing (trailing silence)** | **300–600 ms** | dominates the budget; the main tuning knob |
| ASR final emitted after endpoint | 150–400 ms | |
| Fragment merge / batching hold | 0–300 ms | §3.4 |
| Network + Claude time-to-first-token | 250–500 ms | with a warm cached prefix |
| Generate ~25 output tokens | 250–400 ms | one subtitle line |
| Paint | 16–50 ms | |
| **End-to-end** | **~1.0–2.3 s** | |

**Why 1.5 s and not 0.5 s.** Professional live captioning runs 3–5 s behind; simultaneous interpreters sit 2–4 s behind the speaker. At 1.5 s this pipeline is already ahead of a human interpreter, and below roughly 1 s the improvement stops being perceptible because the viewer needs reading time regardless. Chasing sub-second latency costs tokens (speculative translation) and accuracy (early endpointing) for no felt benefit.

- [ ] Instrument every row above separately from day one (§4)
- [ ] Report p50/p95/p99, never the mean

### 0.4 Cost ceiling

| Target | Value |
|---|---|
| Ceiling | $1.00 per hour of audio, all-in (ASR + translation) |
| Target | $0.60 per hour |

Predicted translation cost. Assumptions: ~720 utterances/hour (12/min, dialogue-dense anime) up to ~1,200/hour (20/min, talk stream); per request ≈ 1,500-token cached prefix (system prompt + glossary), ~280 uncached tokens (rolling window + current line), ~25 output tokens.

| Model | Input / Output per MTok | Per request | 720 utt/hr | 1,200 utt/hr |
|---|---|---|---|---|
| Haiku 4.5 | $1 / $5 | $0.00056 | $0.40 | $0.67 |
| Sonnet 5 | $2 / $10 | $0.00111 | $0.80 | $1.33 |
| Opus 5 | $5 / $25 | $0.00278 | $2.00 | $3.33 |

Hosted streaming ASR adds roughly **$0.15–0.50/hour** depending on vendor.
- [ ] **Verify current ASR vendor pricing** — the range above is unverified.

**Cache economics.** Cache reads cost 0.1× base input; writes cost 1.25× (5-minute TTL). Because subtitle traffic is continuous, consecutive requests start well under 5 minutes apart and keep the default cache alive indefinitely — so the 1.25× write is paid roughly **once per session**, and the 1-hour TTL (2× write) buys nothing. Cache write cost is negligible here and can be left out of the per-hour model.

**Proposed default:** Sonnet 5 + hosted ASR ≈ $0.95/hr at the low utterance rate. Haiku 4.5 as an explicit "cost mode". Opus 5 reserved for generating the Stage 7 reference translations, not for live use.
- [ ] Confirm the model choice against real quality data in Stage 7 rather than assuming it now

### 0.5 Remaining Stage 0 items

- [ ] Which content is the actual target (anime, VTuber streams, news, live calls)? Utterance rate and register differ enough to change both the cost model and the prompt.

---

## Stage 1 — Audio Capture and Chunking

### 1.1 Capture
- [x] ~~System audio loopback~~ — out of scope for the extension route (revisit only if a desktop build happens)
- [ ] Browser tab audio via `chrome.tabCapture`, driven from an offscreen document
- [ ] Re-pipe captured audio to an `AudioContext` destination so the tab is not muted
- [ ] Microphone input path (secondary; `getUserMedia`, for calls rather than media playback)

### 1.2 Voice activity detection
- [ ] VAD library choice (Silero via ONNX Runtime Web, or WebRTC VAD)
- [ ] Utterance boundary detection
- [ ] Silence-based chunking rather than fixed intervals
- [ ] Minimum / maximum utterance length handling
- [ ] **Japanese pause behaviour:** frequent short mid-sentence pauses (fillers, `〜ね`, `えっと`) will trip an aggressive endpointer and over-fragment clauses. Start around 500 ms of trailing silence and tune against real audio.

### 1.3 Buffering
- [ ] Ring buffer sizing
- [ ] Sample rate and format normalisation (AudioWorklet → 16 kHz mono PCM)

### 1.4 Segmentation ownership
**Decide once, not twice.** §1.2 splits on silence and §3.4 merges fragments back together — the same decision made at two layers. Pick one:
- [ ] (a) VAD emits translation units directly, with no merging downstream, or
- [ ] (b) an explicit segmenter stage sits between ASR and translation and owns all boundary decisions

Option (b) is likely right for Japanese, since acoustic silence and clause boundaries diverge often (see §3.5).

---

## Stage 2 — Speech Recognition

### 2.1 Engine selection
- [ ] Hosted streaming option: Deepgram, AssemblyAI, Gladia — the practical default for the extension route
- [ ] In-browser option: whisper.cpp via WASM / `transformers.js` — zero marginal cost, but check whether the small models hit the Japanese accuracy bar and the latency budget
- [ ] Benchmark all candidates on Japanese specifically — Japanese WER varies far more across engines than English does
- [ ] Benchmark: accuracy vs. latency vs. cost

### 2.2 Interim vs. final transcripts
- [ ] Handle rewriting interim results
- [ ] Stability heuristic: when is an interim safe to forward?
- [ ] Timeout rule for stalled finals
- [ ] Note: for Japanese, interim stability is worth much less than it sounds — see §4.1

### 2.3 Metadata
- [ ] Utterance-level timestamps (word-level is less meaningful for Japanese, which has no spaces — engines segment inconsistently)
- [ ] Speaker diarisation (optional, but valuable for multi-speaker content, where pro-drop makes speaker identity load-bearing — see §3.5)
- [ ] Confidence scores for downstream filtering

---

## Stage 3 — Translation with Claude

### 3.1 Request design
- [ ] Streaming responses
- [ ] System prompt: domain, register, output format constraints
- [ ] Suppress preamble and commentary in output

### 3.2 Prompt caching
- [ ] Cached prefix: glossary, character names, domain context
- [ ] Cache invalidation strategy as the glossary grows
- [ ] Keep the glossary at the **front** of the prefix and the rolling window **after** the last cache breakpoint — prefix matching means any byte change invalidates everything downstream
- [ ] Verify with `usage.cache_read_input_tokens`; if it is zero across repeated requests, something in the supposedly stable prefix is varying

### 3.3 Context management
- [ ] Rolling window of previously translated lines
- [ ] Window size vs. token cost tradeoff
- [ ] **The rolling window defeats caching for its own tokens.** The glossary prefix caches fine, but the window differs on every request, so those ~250 tokens are billed at full input price every time. That is already accounted for in the §0.4 model — just do not expect caching to make context free.

### 3.4 Batching
- [ ] Merge short fragments before dispatch — but see §1.4; decide which layer owns this
- [ ] Sentence-completion heuristics (for Japanese: clause-final verb forms and sentence-ending particles `よ` / `ね` / `か` / `から`, not silence alone)

### 3.5 Japanese-specific translation problems

These are the top quality risks, ahead of anything in the ASR stage.

- [ ] **Pro-drop.** Japanese omits subjects constantly, and unlike Spanish there is no verb agreement to recover person from. 「行った」 is "I / you / he / she / they went" with no marking at all. English requires a pronoun, so the model must infer one on nearly every line — and a wrong guess is a visible, jarring error. This makes §3.3's context window mandatory rather than an optimisation, and argues for a larger window (6–10 lines) than Chinese would need.
- [ ] **Recover person from honorifics, not just context.** Giving and receiving verbs and keigo encode direction: 「くれる」 (someone did it for me) vs 「あげる」 (I did it for someone); humble forms mark the speaker, honorific forms mark the addressee. Teach these in the system prompt — they resolve many pronouns that the surrounding lines cannot.
- [ ] **Verb-final word order (SOV).** Negation, tense, and politeness all land on the final morphemes. This breaks fragment-by-fragment translation: a clause translated before its ending can invert in meaning. Never dispatch a partial clause.
- [ ] **Role language (役割語).** Fiction encodes character through speech style — pronoun choice (`俺` / `僕` / `私` / `わし`), sentence-ending particles, dialect. Flattening every character into neutral English loses most of the characterisation. Decide how much of this to attempt and put the policy in the system prompt.
- [ ] **Register.** Casual / polite / humble / honorific are grammatically marked in Japanese and only lexically available in English. Define a consistent mapping rather than letting it drift line to line.
- [ ] **Sentence-boundary mismatch.** Japanese and English clause order differ enough that a strict one-in-one-out mapping reads badly. Decide whether the output may merge or split relative to source lines, and how the renderer handles it when it does.

---

## Stage 4 — Latency Engineering

- [ ] Async task separation: capture / ASR / translation queues
- [ ] Backpressure when translation falls behind — drop lines rather than accumulate lag (see the §0.3 hard drop)
- [ ] Per-stage instrumentation matching the §0.3 table
- [ ] Latency distribution, not just averages

### 4.1 Speculative translation — likely NOT worth it for Japanese

Speculative translation of stable interims assumes that a growing transcript prefix has stable meaning. **For Japanese that assumption is false**: because the verb is final, 食べます / 食べません / 食べたくなかった diverge only at the end, so a speculative translation of the prefix is about as likely to be inverted as correct. The token cost is roughly 2–3× (every revised interim is another request) for a saving of perhaps 300–500 ms — which the §0.3 budget already absorbs.

- [ ] Treat this as **deferred, not planned.** Revisit only if measured p95 exceeds 2.5 s.
- [ ] If revisited, speculate on **clause completion** (predicting the ending from context) rather than on token-prefix stability
- [ ] This partially answers Open Question 2 — record the measurement once Stage 4 is instrumented

---

## Stage 5 — Subtitle Rendering

### 5.1 Surface
- [ ] Injected overlay div in a shadow DOM (extension route)
- [ ] Survives the host page's fullscreen video container
- [ ] Positioning and persistence across sessions

### 5.2 Display logic
- [ ] Reading-speed pacing (~20 chars/sec, max two lines)
- [ ] Dwell time and clearing rules
- [ ] Behaviour when a new line arrives before the previous one has been read
- [ ] Optional dual display: Japanese source above the English translation
- [ ] Behaviour when translation merges or splits lines relative to the source (§3.5)

### 5.3 Styling
- [ ] Font, size, outline/shadow for legibility over video
- [ ] User-configurable appearance

---

## Stage 6 — Cost, Fallback, and Failure

- [ ] Token accounting per minute of audio; validate against the §0.4 prediction
- [ ] Live cost-per-hour readout in the UI
- [ ] "Cost mode" switch: Haiku 4.5 instead of Sonnet 5
- [ ] Local model fallback (Gemma, Qwen) behind the same interface
- [ ] Runtime switching between hosted and local backends

### 6.1 Degradation behaviour

What the user sees when things go wrong — the most visible failure surface, and currently the least specified part of the design.

- [ ] ASR returns garbage or empty text → suppress the line, or show the source untranslated?
- [ ] Claude API returns 429 → back off, and show what in the meantime?
- [ ] Network drops mid-session → reconnect strategy, and whether to buffer or discard the gap
- [ ] Translation queue exceeds the §0.3 hard drop → drop silently, or show a dropped-line indicator?
- [ ] Audio present but no speech detected for a long stretch → distinguish "silence" from "broken pipeline" in the UI
- [ ] Never leave a stale subtitle on screen when the pipeline has stalled

---

## Stage 7 — Evaluation

- [ ] Reference set: ~10 minutes of Japanese audio with human English translation
- [ ] **Build the reference set during build step 1, not at the end** — it is the only way to tell whether a prompt change helped, and step 1 is exactly when the prompt is being written
- [ ] End-to-end scoring (ASR errors propagate into translation)
- [ ] Separate ASR-only and translation-only scores to isolate failures
- [ ] Latency measured alongside quality
- [ ] Prompt version comparison harness
- [ ] Track pronoun-resolution accuracy as its own metric — it is the failure mode most visible to a viewer (§3.5)

---

## Build Order

1. **Offline, file-based** — Japanese audio file in, English `.srt` file out. No timing pressure; get the translation prompt and the Japanese-specific handling in §3.5 right here. Build the Stage 7 reference set in this step.
2. **Live capture** — swap the file source for `chrome.tabCapture` in an offscreen document, keep everything else.
3. **Streaming and overlay** — add progressive output and the injected rendering surface.
4. **Optimisation** — caching, cost tuning, and (only if the measurements demand it) speculative translation.

---

## Open Questions

- [ ] How much surrounding context is enough for pronoun resolution in a pro-drop language? Expect this to need more lines than intuition suggests.
- [ ] Is speculative translation worth the token cost at the target latency? — **provisional answer: no, for Japanese** (§4.1). Confirm by measurement.
- [ ] Does in-browser WASM ASR + Claude beat hosted ASR + a local LLM? Both are file-based in build step 1, so this is cheap to answer early — and the answer determines the whole cost structure. Pull it forward.
- [ ] Can `tabCapture` reach DRM-protected audio? If not, what content is actually in scope?
