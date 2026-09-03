# Evaluation set

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

## Status

- [x] Japanese source captured
- [x] YouTube baseline captured and error-categorised
- [x] Two-pass translation of the same window (in-session, not via API)
- [ ] **Human reference translation** — the real arbiter; both outputs above are currently judged by the same party that produced one of them
- [ ] Re-run through the actual API with a controlled prompt, to confirm the result holds outside a chat session
- [ ] Second fixture from the anime profile
- [ ] Blind scoring by someone who did not write the taxonomy
