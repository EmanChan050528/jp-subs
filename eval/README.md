# Evaluation set

The reference set the design doc (§7) calls for. Built during the caption-access testing on 2026-09-03.

## Fixtures

| File | What it is |
|---|---|
| `fixtures/EmteTL5Ij8g_30-40min.ja.json` | Japanese source. YouTube auto-generated ASR track, 131 cues from a 10-minute window (30:00–40:00) of a 7h53m VTuber archive. 1,526 Japanese characters. |
| `fixtures/EmteTL5Ij8g_30-40min.youtube-en.json` | **Baseline competitor.** YouTube's own auto-translated English for the identical window, aligned 1:1 by `t_ms`. |

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

## Status

- [x] Japanese source captured
- [x] YouTube baseline captured and error-categorised
- [ ] Claude translation of the same window (blocked: no API credentials configured)
- [ ] Human reference translation, for scoring both
- [ ] Second fixture from the anime profile
