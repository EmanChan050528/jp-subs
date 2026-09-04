# Evaluation set

> **These scores are internal, not independent.** Every comparison here was
> made by the same party that produced one of the outputs, against a taxonomy
> that party wrote. A human reference translation would settle it; it is parked
> in [`reference/`](reference/) waiting on a Japanese reader. Read the numbers
> as a self-assessment.

The reference set the design doc (§7) calls for. Built during the caption-access testing on 2026-09-03.

## Fixtures

| File | What it is |
|---|---|
| `fixtures/EmteTL5Ij8g_30-40min.ja.json` | Japanese source. YouTube auto-generated ASR track, 131 cues from a 10-minute window (30:00–40:00) of a 7h53m VTuber archive. 1,526 Japanese characters. |
| `fixtures/EmteTL5Ij8g_30-40min.youtube-en.json` | **Baseline competitor.** YouTube's own auto-translated English for the identical window, aligned 1:1 by `t_ms`. |
| `fixtures/NSY6YHXbxtA_full.ja.json` | Japanese source, whole video (21:52, 202 cues). Produced by the extension itself, not by hand. A VTuber reaction compilation over game dialogue. |

### Cue granularity varies a lot between videos

Both Japanese fixtures are `kind=asr`, but they are segmented completely differently:

| | `EmteTL5Ij8g` | `NSY6YHXbxtA` |
|---|---|---|
| Mean chars per cue | 6.6 | 16.0 |
| Max chars per cue | ~20 | 75 |
| Shape | scrolling fragments, break mid-clause | mostly complete, punctuated sentences |

**Do not assume fragments.** Stage 2 re-segmentation has to cope with both a
stream of 6-character scraps and cues that are already whole sentences — and it
must not mangle the latter while trying to repair the former. Keep both
fixtures in the regression set for exactly this reason.

Content profile: solo VTuber gameplay stream (不知火フレア / Hololive), unscripted casual speech with heavy pro-drop, fillers, and domain vocabulary. This is the hard profile, not the easy one.

## Why the baseline matters

YouTube already gives every viewer auto-translated English captions for free, in one click. That — not "no subtitles" — is what this project has to beat. If it cannot, it has no reason to exist.

## Baseline failure taxonomy (observed, 131 cues)

YouTube translates **each cue independently**, with no context from neighbouring cues. Nearly every error below traces to that one decision, and each is a category this project's document-level design is specifically built to fix.

### 1. Polarity inversion from fragmentation — the most serious

Source (merged): 「基本的に大会は対人系は参加あんまりしないので」 — *"I generally don't take part in PvP tournaments."*

| Cue | YouTube |
|---|---|
| `2160359` | "Basically, I participate in tournaments that involve playing against other people." |
| `2163920` | "I don't do it very often." |

The negation lives in the *next* cue, so the first cue asserts the exact opposite of what was said. A viewer reading at speed takes away the wrong meaning. This is the verb-final (SOV) hazard the design predicted in §3.3 — Japanese puts polarity at the end of the clause.

### 2. Pro-drop misattribution

`2188920` 「あ、寝ちゃった。」 → YouTube: *"Oh, I fell asleep."*

She is hunting for a creature in-game; it is the creature that fell asleep, not the speaker. Japanese marks no subject, YouTube defaults to first person, and the line becomes nonsense against the picture. Exactly the §3.3 pro-drop failure — and exactly what forward context (§3.2) is meant to resolve.

### 3. Sentence fragments translated as standalone content

`2073480` 「たら」 → YouTube: *"Tara"*

`たら` is the conditional ending of the previous cue's verb (…やりすぎ**たら** = "if everyone went all out…"). Stripped of its stem it is meaningless, so it was rendered as a proper noun. Others in the same window: 「で」→"in", 「して」→"do", 「仕様」→"specification".

### 4. Domain vocabulary

`2152520` 「配信」 → YouTube: *"delivery"*

In VTuber context 配信 is "stream" / "broadcast". The dictionary sense is wrong here and appears in nearly every stream. This is precisely what the §3.1 per-channel glossary exists to fix.

### 5. Hallucinated content

`2093280` 「調子と相談」 → YouTube: *"Consult with your doctor"*

Source (merged): 「普通に私の調子と相談してやってく」 — *"I'll go by how I'm feeling."* No doctor exists anywhere in the source. Both the referent and the content are invented.

### 6. Referent loss

`2168319`–`2171599` 「またフレちゃんいないんだみたいな風になる時」 → *"…somehow at the tournament, Fre-chan"* / *"When it feels like they're not there"*

The speaker is referring to **herself** in third person by her own nickname — routine in VTuber speech. Split across cues, the connection is lost and "Fre-chan" becomes an unrelated third party.

### 7. Coverage cliff

YouTube's English track for this video stops at **24,204s of 28,382s** — exactly 5,000 cues, 85% of the video. The final ~70 minutes have no English subtitles at all. Long archives are precisely the VTuber case, so this is not an edge case.

## Head-to-head: YouTube vs. document-level translation

`fixtures/EmteTL5Ij8g_30-40min.claude-en.json` is the same 131 cues translated with the two-pass design: a glossary and speaker model built from the whole window first, then translation of merged sentences with forward and backward context.

**Read the caveat in that file.** It was produced in a Claude Code session rather than through a controlled API call, by a translator who already knew which failure categories to look for. It shows the approach can fix these errors; it is not a blind measurement that it will.

Every failure category above is resolved:

| # | Source | YouTube | Two-pass |
|---|---|---|---|
| 1 | 大会は対人系は参加あんまりしない | "I participate in tournaments that involve playing against other people." | "I generally don't enter PvP tournaments." |
| 2 | あ、寝ちゃった。 | "Oh, I fell asleep." | "Oh, it fell asleep." |
| 3 | …やりすぎ**たら** | "Tara" | "then" (attached to the preceding conditional) |
| 4 | 配信でなんかやりたくない | "delivery" | "so on stream / that's something / I'd rather not do" |
| 5 | 私の調子と相談して | "Consult with your doctor" | "I'll just go by how I'm feeling" |
| 6 | またフレちゃんいないんだ | "Fre-chan" / "they're not there" | "Flare's not in this one again" |
| 7 | 仕様で | "specification" / "in" | "That's just how it works." |

### The unexpected result: context repairs ASR errors

The one finding that was not predicted. Two cues contain homophone errors from YouTube's speech recognition, and document context is enough to catch both:

| Source (as recognised) | Correct | YouTube | Two-pass |
|---|---|---|---|
| 高感度イベント | 好感度イベント | "a high-sensitivity event" | "the affection events" |
| 自立神経 | 自律神経 | "My autonomic nervous system is broken." | "wrecked my autonomic nervous system" |

`高感度` ("high sensitivity") and `好感度` ("affection level") are homophones. In a farming sim only one is meaningful, and knowing the game is a farming sim is exactly what pass 1 establishes. YouTube translates the error literally because it sees one cue and no domain.

This matters for the design: **the translation stage can absorb some ASR error**, which reduces the pressure on transcript quality and makes the auto-generated caption tier (§1.4) more viable than it looked.

### What is not better

Honesty about the null results:

- **Short interjections are a wash.** 「はい」「よし」「こら」 — both produce fine output. Roughly a third of cues in this window are short enough that context buys nothing.
- **Output is not shorter.** 741 English words vs YouTube's 803 — a 7% reduction, not a meaningful gain in reading speed.
- **Both mis-handle 「誰かときそう」**, an ASR garble neither reading resolves confidently.

The gap is concentrated in the ~15–20 cues carrying real semantic content across cue boundaries. Those are also the cues a viewer most needs to be right.

## Qwen3.5:9b vs. YouTube — measured 2026-09-03

Run: `core/bin/jpsub.js translate` on the 131-cue fixture, local Ollama,
`qwen3.5:9b`, `think:false`. Output: `fixtures/EmteTL5Ij8g_30-40min.qwen35-9b-en.*`.

**75/78 units in 24.5 seconds**, on a 12 GB RTX 5070. That is ~24x faster than
real time, which comfortably clears the §0.3 ahead-of-playhead target: a 24-min
episode lands in about a minute, a 4-hour archive in about ten.

### Beats the baseline: 5 of 7 categories

| # | Source | YouTube | Qwen3.5:9b |
|---|---|---|---|
| 1 | 大会は対人系は参加あんまりしない | "I participate in tournaments that involve playing against other people." | **"I don't participate in many PvP tournaments"** |
| 3 | 仕様 | "specification" | "It's a game mechanic." |
| 4 | 対人 | "team games" / vague | "PvP" |
| 5 | 私の調子と相談して | "Consult with your doctor" | "I'll decide based on my condition" |
| 6 | またフレちゃんいないんだ | referent lost | "people think, 'Oh, Fure-chan isn't there again'" |

Category 1 is the important one — YouTube states the **opposite** of what was
said, and Qwen gets it right. Note this one is fixed by segmentation, not by the
model: merging the negation into the same unit as its verb removes the failure
before translation happens.

Category 6 works because pass 1 caught the self-reference on its own: *"The
speaker refers to themselves in the third person as 'フレちゃん'."* That is
exactly what the two-pass design exists to do.

### Still fails: 2 of 7

| # | Source | Correct | Qwen3.5:9b | |
|---|---|---|---|---|
| 2 | あ、寝ちゃった。 | "Oh, it fell asleep." | "Ah, I fell asleep." | Same error as YouTube |
| — | 高感度イベント | 好感度 → "affection events" | "high-difficulty event" | Identified the ASR error, picked the wrong fix (高難度) |

**Pro-drop is the unsolved one.** It was predicted as the top quality risk in
design §3.3, and it survives both a strong model and forward context. The
creature falling asleep is visible on screen and nowhere in the text, so this
particular instance may be genuinely unreachable without vision. Worth checking
how often that is true before assuming the category is lost.

### Reliability gap

3 of 78 units came back untranslated — the model omitted keys from its JSON
response — including one long, substantive line about team composition. Those
become **blank subtitles**, not wrong ones. The pipeline reports it loudly
rather than hiding it, but chunks with missing lines should be retried.

### Other observations

- Names are romanised phonetically: フレ → "Fure", not "Flare" (the streamer is
  不知火フレア / Shiranui Flare). Consistent, so it does not read as an error,
  but it is wrong. A seeded glossary from the channel would fix it.
- 配信 never entered the glossary, yet the surrounding sentence still came out
  right — the model handled it from context.

### Verdict

Qwen3.5:9b clears the baseline. The gap is real, it is concentrated where
predicted, and it runs locally at 24x real time for free. Pro-drop and the
dropped-line reliability issue are the two things worth working on next; neither
is a reason to switch to Gemini yet.

## Multi-hour VOD, end to end — 2026-09-04

The 7h53m archive (`EmteTL5Ij8g`) run in full through the CLI on `qwen3.5:9b`.
First time the pipeline has seen a video at this scale.

| | |
|---|---|
| Cues | 5,729 |
| Units after segmentation | 5,039 |
| Chunks | 252 |
| **Translated** | **5,038 / 5,039** |
| Wall clock | **1,011 s (16m 51s)** |
| Coverage | last unit at 28,376 s of 28,382 s — 100% |
| Output | 0.36 MB `.srt`, 0.87 MB `.en.json` |
| Cache entry size | **417 KB** |

Everything built for scale did its job:

- **Pass-1 sampling engaged**, reducing 5,039 units to 388 (5,943 chars), and
  still produced a usable glossary — 10 names, 11 terms, 9 ASR corrections.
  Without it the analysis prompt would have been ~75,000 characters.
- **Retries fired 17 times** across 252 chunks and recovered all but one line.
  Final completion 99.98%.
- **17 minutes matches the ETA estimate** of ~15 minutes given earlier.
- **417 KB per entry** confirms the cache sizing: the 7 MB budget holds roughly
  17 videos of this length.

Not covered by this run: the MV3 service-worker lifetime, which is the actual
risk on long videos and only appears when driving the extension rather than
the CLI.

### Defect found: over-long subtitles

**5.9% of subtitles exceed 84 characters** — more than two 42-character lines
can hold. Worst case is a 293-character English line from a 61-character
Japanese unit, a 4.8x expansion, where the model explained rather than
translated.

Tightening the prompt (an explicit length rule instead of "prefer short and
clear") did **not** measurably help: 21.3% -> 19.2% over 84 chars on the small
fixture, which is inside the noise for 78 units. Recording that as a negative
result rather than a fix.

The cause is structural: segmentation allows 64-character Japanese units, and
Japanese expands 2-4x into English, so a full-width unit legitimately lands
around 150 characters. The real levers are a smaller `maxChars` in
segmentation (at the cost of more chunks and more fragmented translation) or
accepting three-line subtitles. For now `srt.js` allows a third line rather
than jamming the remainder onto line two, which produced an unreadable run-on.

## Status

- [x] Japanese source captured
- [x] YouTube baseline captured and error-categorised
- [x] Two-pass translation of the same window (in-session, not via API)
- [ ] **Human reference translation** — the real arbiter; both outputs above are currently judged by the same party that produced one of them
- [ ] Re-run through the actual API with a controlled prompt, to confirm the result holds outside a chat session
- [ ] Second fixture from the anime profile
- [ ] Blind scoring by someone who did not write the taxonomy
- [x] Qwen3.5:9b run, scored against the baseline (above)
- [ ] Retry chunks that come back with missing lines
- [ ] Compare against Gemini, if the remaining gaps justify it
