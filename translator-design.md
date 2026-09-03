# Real-Time Voice Translation Subtitles

A pipeline that captures live audio, transcribes it with a speech recognition model, translates the text with the Claude API, and renders the result as overlay subtitles.

**Key constraint:** the Claude API does not accept audio input. Speech recognition and translation are two separate stages, and the boundary between them is where most of the interesting engineering lives.

---

## Stage 0 — Scope and Targets

- [ ] Source languages (Chinese, Korean, other)
- [ ] Target language(s)
- [ ] Latency budget (define a number before writing code)
- [ ] Cost ceiling per hour of audio
- [ ] Platform: desktop overlay, browser extension, or both

---

## Stage 1 — Audio Capture and Chunking

### 1.1 Capture
- [ ] System audio loopback
  - macOS: BlackHole / virtual device
  - Windows: WASAPI loopback
  - Linux: PulseAudio monitor source
- [ ] Microphone input path
- [ ] Browser tab audio via `chrome.tabCapture` (extension route)

### 1.2 Voice activity detection
- [ ] VAD library choice (Silero, WebRTC)
- [ ] Utterance boundary detection
- [ ] Silence-based chunking rather than fixed intervals
- [ ] Minimum / maximum utterance length handling

### 1.3 Buffering
- [ ] Ring buffer sizing
- [ ] Sample rate and format normalisation

---

## Stage 2 — Speech Recognition

### 2.1 Engine selection
- [ ] Local option: faster-whisper / whisper.cpp
- [ ] Hosted streaming option: Deepgram, AssemblyAI, Gladia
- [ ] Benchmark: accuracy vs. latency vs. cost

### 2.2 Interim vs. final transcripts
- [ ] Handle rewriting interim results
- [ ] Stability heuristic: when is an interim safe to forward?
- [ ] Timeout rule for stalled finals

### 2.3 Metadata
- [ ] Word-level timestamps
- [ ] Speaker diarisation (optional)
- [ ] Confidence scores for downstream filtering

---

## Stage 3 — Translation with Claude

### 3.1 Request design
- [ ] Streaming responses
- [ ] System prompt: domain, register, output format constraints
- [ ] Suppress preamble and commentary in output

### 3.2 Prompt caching
- [ ] Cached prefix: glossary, character names, domain context
- [ ] Cache invalidation strategy as glossary grows

### 3.3 Context management
- [ ] Rolling window of previously translated lines
- [ ] Handling dropped subjects and pronouns in CN/KR source
- [ ] Window size vs. token cost tradeoff

### 3.4 Batching
- [ ] Merge short fragments before dispatch
- [ ] Sentence-completion heuristics

---

## Stage 4 — Latency Engineering

- [ ] Async task separation: capture / ASR / translation queues
- [ ] Backpressure when translation falls behind
- [ ] Speculative translation of stable interims, with cancellation
- [ ] Per-stage instrumentation (capture, VAD, ASR, network, translation)
- [ ] Latency distribution, not just averages

---

## Stage 5 — Subtitle Rendering

### 5.1 Surface
- [ ] Transparent always-on-top window (Electron / Tauri / Qt)
- [ ] Or injected overlay div for the extension route
- [ ] Positioning and persistence across sessions

### 5.2 Display logic
- [ ] Reading-speed pacing (~20 chars/sec, max two lines)
- [ ] Dwell time and clearing rules
- [ ] Behaviour when a new line arrives before the previous is read
- [ ] Optional dual display: source text above translation

### 5.3 Styling
- [ ] Font, size, outline/shadow for legibility over video
- [ ] User-configurable appearance

---

## Stage 6 — Cost and Fallback

- [ ] Token accounting per minute of audio
- [ ] Reported cost per hour of viewing
- [ ] Local model fallback (Gemma, Qwen) behind the same interface
- [ ] Runtime switching between hosted and local backends

---

## Stage 7 — Evaluation

- [ ] Reference set: ~10 minutes of audio with human translation
- [ ] End-to-end scoring (ASR errors propagate into translation)
- [ ] Separate ASR-only and translation-only scores to isolate failures
- [ ] Latency measured alongside quality
- [ ] Prompt version comparison harness

---

## Build Order

1. **Offline, file-based** — audio file in, `.srt` file out. No timing pressure; get the translation prompt right here.
2. **Live capture** — swap the file source for real-time audio, keep everything else.
3. **Streaming and overlay** — add progressive output and the rendering surface.
4. **Optimisation** — speculative translation, caching, cost tuning.

---

## Open Questions

- [ ] How much surrounding context is enough for pronoun resolution?
- [ ] Is speculative translation worth the token cost at the target latency?
- [ ] Does a local ASR + Claude combination beat a hosted ASR + local LLM combination?
