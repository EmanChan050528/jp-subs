# Core — build step 2

Japanese transcript in, English subtitles out. Takes the `.ja.json` the
extension produces and writes `.en.srt` plus `.en.json`.

Node, no required dependencies. Written in JS rather than Python because build
step 3 folds this logic into the extension, and a rewrite then would be waste.

## Use

```bash
node bin/jpsub.js segment   ../eval/fixtures/NSY6YHXbxtA_full.ja.json
node bin/jpsub.js translate ../eval/fixtures/NSY6YHXbxtA_full.ja.json --model qwen3.5:9b
```

`segment` calls no model at all. Run it first on any new video — it is instant,
free, and segmentation is where the subtle damage happens.

| Option | Default | |
|---|---|---|
| `--backend` | `ollama` | or `gemini` |
| `--model` | `qwen3.5:9b` | |
| `--size` | 20 | units translated per request |
| `--context-before` | 10 | read-only units before |
| `--context-after` | 6 | read-only units after |
| `--limit` | — | only the first N cues; use this first |
| `--out` | input's directory | |

## Backends

**Ollama (primary).** Needs `ollama serve` running and the model pulled:

```bash
ollama pull qwen3.5:9b
```

**Gemini (fallback). Unverified** — the call shape follows Google's current
quickstart, checked 2026-09-03, but this path has never been run. Needs
`npm install @google/genai` and `GEMINI_API_KEY`. Expect to fix it on first use.

## How it works

Two passes, because that is where the quality gap over YouTube's per-cue
translation comes from (`../eval/README.md`).

1. **`segment.js`** — cues to translation units.
2. **`pipeline.js` pass 1** — read the whole transcript, build a glossary:
   setting, speakers, names, domain terms, ASR corrections, register.
3. **`pipeline.js` pass 2** — translate chunks, each with the glossary plus
   read-only units before *and after*. The forward window is the whole reason
   to do this on VOD; a live pipeline can never have it.
4. **`srt.js`** — units and translations to `.srt`, timings carried through
   from the original cues.

### Segmentation is the subtle part

Cue granularity varies enormously between videos, even within `kind=asr`:

| | `EmteTL5Ij8g` | `NSY6YHXbxtA` |
|---|---|---|
| Mean chars/cue | 6.6 | 16.0 |
| Shape | scrolling fragments, break mid-clause | several whole sentences per cue |

These need opposite treatment, so `segment.js` works at sentence level rather
than cue level: every cue is exploded into sentence pieces, then pieces
accumulate into units until sentence-final punctuation, a 2 s silence, or a
64-character cap.

**Sentence breaks land on real timestamps.** YouTube's json3 carries word-level
timings (`tOffsetMs` per segment) on roughly half of all cues, so a piece starts
at the actual time of its first character. Where a cue has no word timings the
start is still apportioned by character count — several pieces cannot share a
start, or only the last would ever display — but the end is anchored to the
cue's own end so nothing expires before the speech does.

This matters more than it sounds. Measured on the 131-cue fixture, switching
from estimated to real timings moved **22 of 78 unit starts, the worst by
4.3 seconds**, and every correction was negative: the character-count estimate
ran consistently late, because it assumes an even speaking rate and speech has
pauses.

One rule, both shapes. Measured result: 131 cues → 78 units on the fragmented
video (merging), 202 cues → 235 units on the sentence-dense one (splitting).

## Status

- [x] Segmentation, verified on both fixture shapes
- [x] Chunking with forward and backward context
- [x] Two-pass prompts, targeting the measured failure categories
- [x] SRT output with wrapping and minimum dwell
- [x] Ollama backend
- [x] Pipeline verified end to end (78/78 units, 38 s, on `gemma3:4b`)
- [x] **Quality run on `qwen3.5:9b`** — beats the YouTube baseline on 5 of 7
      failure categories, 78/78 units in ~24 s. Scored in `../eval/README.md`.
- [x] Retry for lines the model omits from its JSON
- [x] Pass 1 failure degrades instead of aborting the run
- [x] Pass 1 input sampled for long videos (a 4-hour archive is ~75,000 chars
      and will not fit any local context)
- [ ] Gemini backend, if the remaining gaps justify it — still unverified

## What the first smoke test showed

Kept for the record. Run on `gemma3:4b` (a stand-in — too small for this job,
but it exercised every code path); the Qwen3.5 results that superseded it are
in `../eval/README.md`. Against the seven failure categories in `../eval/README.md`:

**Fixed by segmentation alone** — the polarity inversion. Merging the negation
into the same unit as its verb removes the failure before the model sees it.
「大会は対人系は参加あんまりしない」 came out as "I don't participate in…",
where YouTube asserts the opposite. Worth noting this win costs nothing and
does not depend on model quality.

**Still wrong on a 4B model**, and the reason the glossary matters:

| Source | gemma3:4b | Should be |
|---|---|---|
| あ、寝ちゃった。 | "oh, I'm asleep" | "oh, it fell asleep" |
| 高感度イベント | "high-sensitivity events" | "affection events" |
| 対人 | "team games" | "PvP" |
| フレちゃん | "no friends to play with" | "Flare" (self-reference) |

All four are glossary-dependent, and that run produced an **empty glossary** —
so pass 1 contributed nothing and the output was effectively per-chunk
translation. The prompt is fine; probing pass 1 directly on the same model gave
a good reference sheet including 配信 → "stream" and フレ → "Flare".

That silent degradation is now guarded: `analyse()` retries once and prints a
loud warning if the glossary is still empty, because a run with no glossary
still "succeeds" while producing markedly worse subtitles.
