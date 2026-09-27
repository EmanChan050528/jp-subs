# Korean: measured findings

Measured 2026-09-27 against `fixtures/k9QHpWEX2WA_full.ko.srt` — the full
Korean ASR track of a 147-minute StelLive VOD (Korean VTuber agency,
multi-member unscripted talk), pulled with yt-dlp. Compared throughout against
`fixtures/EmteTL5Ij8g_30-40min.ja.json`.

This settles the questions `korean-readiness.mjs` left open about the *data*.
It does not settle quality — see "Still open" at the bottom.

## Track profile

| | Korean (StelLive) | Japanese (EmteTL5Ij8g) |
|---|---|---|
| Cues | 3,859 | 131 |
| Mean chars/cue | 13.9 | 11.6 |
| **Ends in terminal punctuation** | **41.5%** | **31.3%** |
| **`>>` speaker markers** | **53.1%** | **0%** |
| `[tag]`-only cues | 73 | 1 |
| Overlaps the previous cue | 95.0% | 66.4% |

## 1. Korean ASR punctuates — more than Japanese does

This was the question that decided patch-versus-redesign, and it comes out
well. 41.5% of Korean cues end in terminal punctuation against 31.3% for
Japanese. Sentence-level segmentation has more to work with in Korean, not
less.

**Korean is a patch, not a redesign.**

## 2. The one-character fix is worth a great deal

`segment()` as shipped does not treat the ASCII period as a sentence end, which
is the period Korean uses. Measured on the real track, with and without it:

| | As shipped | With `.` as a sentence end |
|---|---|---|
| Units | 1,238 | 2,882 |
| Mean unit chars | 42.8 | 18.1 |
| Units ending in punctuation | 46.6% | **94.4%** |
| Median time on screen | 9.0 s | **4.4 s** |
| Units over 12 s on screen | 207 | 65 |

As shipped, the median Korean subtitle would sit on screen for **nine seconds**
and 207 of them for over twelve — while several sentences of speech go past
underneath. That is unusable, and it is one character in a character class.

## 3. Korean ASR marks speaker changes, and Japanese does not

**53.1% of Korean cues begin with `>>`**, the broadcast-captioning convention
for a speaker change. The Japanese track has none at all.

This is a real and unexpected advantage. The README currently says YouTube's
recognition "produces one undifferentiated stream with no speaker labels, so
nothing downstream can separate two people talking at once" — true of Japanese,
**false of this Korean track**. That claim will need qualifying by language.

It marks a change of speaker, not an identity, so it is a turn boundary rather
than a name. But turn boundaries are most of what the pro-drop problem needs:
pro-drop is the one category still lost to YouTube in Japanese, and the missing
information is who is talking. Korean may end up *better* served than Japanese
on the category Japanese cannot fix without vision.

It also has to be handled deliberately rather than ignored. `>>` is currently
treated as ordinary text, so it ends up welded mid-unit (see below) and would
be fed to the model as content.

## 4. Two defects confirmed on real data

**Cues are joined with no separator.** Visible in the output as `우와>> 시는데`
and `똑같은곳이야요` — words run together across cue boundaries. Correct for
Japanese, wrong for a language written with spaces. This is `current.ja +=
piece.text` in `segment()`.

**Polarity fragmentation is present**, the same hazard as Japanese category 1.
One cue ends `한마도 안` and the next begins `싸웠어` — the negation `안` is
separated from the verb it negates by a cue boundary. Korean puts short-form
negation immediately before the verb, so a boundary between them inverts the
reading of the fragment exactly as it does in Japanese.

## 5. Caption access is unchanged

Fetching the `ko` track's `baseUrl` from the watch page returns HTTP 200 with a
zero-byte body — the same silent refusal recorded in §0.3.0. The interceptor
approach transfers without new research.

## 6. The premise holds: YouTube is bad at Korean, and visibly so

yt-dlp cannot fetch the `en` track — repeated attempts return HTTP 429, because
it requests translated captions without a proof-of-origin token and that path
is throttled hard. The `ko-orig` track downloads fine, so this is not an IP
block.

It is reachable through the player instead, using this project's own §0.3.0
finding: hook `fetch` on the watch page, let the player request its own
captions, and rewrite the captured URL. `sparams` covers only
`ip,ipbits,expire,v,ei,caps,opi,exp,xoaf`, so `tlang` is unsigned and can be
set to `en` on a URL that already carries a valid `pot`. One request, 7,470
events, no rate limit.

The 30:00–40:00 window — matching how the Japanese baseline was built — is
16,869 bytes, SHA-256 `692d4a86dd679d966fe50f9bb5f1d3f123aadf7a130815d8f98228f1433092fb`.
It is **not yet committed**: it has to arrive byte-exact rather than
transcribed, so it needs a file write from the browser session that fetched it.
The observations below were read from that text directly.

**Most of the damage is legible without reading Korean**, because it is
structural damage to the English:

**Negation is severed mid-word.** YouTube splits the contraction across a cue
boundary — one cue ends `...first of all, do` and the next begins `n't dress
hip...`. This happens at least six times in ten minutes (`was`/`n't he`,
`I do`/`n't think I'll cry`, `I have`/`n't grown yet`, `would`/`n't it be
better`). A viewer reading the first cue at speed takes the opposite meaning.
This is Japanese failure category 1, but worse: in Japanese the polarity was
stranded in the *next cue*; here it is stranded mid-token.

**Punctuation arrives as its own subtitle.** Cues consisting of nothing but
`?` or `.` appear five times in the window. They are not translations of
anything.

**Proper nouns are unstable.** The agency name (스텔라이브 / StelLive) is
rendered at least four different ways in ten minutes — as *Stellai*,
*Stellaive*, *Stan Live*, and split across two cues as *Stellar.* / *cadet.*
This is precisely what the per-channel glossary exists to fix, and it is the
easiest win available.

**Fragment cues carry no content**: single words like *Is*, *It's*, *huh*
stranded as standalone subtitles.

The mechanism looks like YouTube translating a cue pair jointly and then
re-splitting the English by character position, with no regard for word or
clause boundaries. That is a different defect from the Japanese case, where
each cue was translated independently — and it is more damaging.

## 7. The ceiling is the ASR, not the translator

First user report of Korean output (2026-09-27): it runs, but the subtitles
read as nonsense — with the right question attached, which is whether the
*source* is nonsense too.

**The pipeline was ruled out first.** The `.srt` fixture has no word-level
`segs`, so it only ever exercised the fallback timing path; about 40% of the
live track's events carry `segs` and go through `charTimes()` instead, a
branch Korean had never run. `fixtures/k9QHpWEX2WA_30-30.5min.ko-segs.json`
covers it now: segmentation is lossless (141 source characters in, 141 out),
no `>>` survives, every turn is found, no unit is empty or padded.

**The source track is genuinely damaged**, and two pieces of evidence need no
Korean to read:

*YouTube transliterates where it cannot parse.* The source has 모시기 볶음 and
YouTube's own English renders it "Moshigi-bokkeum" — a translator falling back
to spelling a phrase out is announcing that the phrase did not resolve.
Elsewhere in the same window it produced "Ttuppae-ttubi-ttubae-ttubi-i".

*YouTube silently repairs names, revealing the damage.* The source reads
방탄수는, which is not the group's name (방탄소년단); YouTube's English says
"BTS's DNA". It guessed the intended referent from context. Our pipeline sees
the same corrupted token.

*Both systems fail in the same places.* Two independent translators fed one
transcript produce nonsense at the same timestamps. That localises the fault
upstream of either.

**Why this track is the hard case.** A 147-minute multi-speaker VTuber talk
show is close to worst-case for speech recognition: overlapping speech,
in-jokes, agency-specific vocabulary, and constant proper nouns. It was chosen
to match the Japanese fixture's difficulty, and it does.

**What this does and does not establish.** It does not show the Korean prompt
is good — that still needs a reader. It does show that on this video the
translator is not the binding constraint, and that a fair comparison is
against YouTube's output on the same lines rather than against the Korean.

## 8. Confirmed on the easy profile

The control ran on `nOdLfDOAMvg` (슈카월드, 28 min, single speaker, clean
audio, semi-scripted). **Output was coherent**, and held up against YouTube's
English dub of the same video.

Read against §7, that closes the question it was designed to answer:

| | StelLive (hard) | 슈카월드 (easy) |
|---|---|---|
| Audio | 147 min, multi-speaker, overlapping | 28 min, one speaker, clean |
| Source ASR | visibly corrupted | clean |
| Our output | nonsense | coherent |

Same prompt, same pipeline, opposite results, and the variable that moved was
the input. **The translator is not the constraint; the speech recognition is.**
Expected quality for Korean therefore tracks audio conditions far more than it
tracks anything in this project.

### Two caveats on that result

**The dub is not the project's baseline, and it is a harder one.** YouTube's
auto-dubbing is a separate system from its auto-translated captions. It works
from whole utterances rather than caption cues, so it never suffers the
cue-fragmentation failure that §7 and the whole §3.2 design exist to fix.
Matching it is a stronger result than matching the captions — but it is not
the comparison `eval/README.md` is built around, and 슈카월드 was flagged in
`korean-candidates.md` as unsuitable for baseline use for exactly this reason:
it carries its own `en-US` and `id` tracks, so the comparison is not
like-for-like.

**Coherent is not accurate, and the gap between them is the whole problem.**
The failure this project exists to fix produces *fluent* wrong English, not
obvious nonsense. The measured Japanese example — 「あ、寝ちゃった。」 rendered
"Oh, I fell asleep" when the thing that fell asleep is on screen — reads
perfectly and is wrong. A reader who does not know the source language cannot
distinguish a correct line from a confidently misattributed one.

So this result establishes that the Korean pipeline **produces well-formed
English from clean input**. It does not establish accuracy, and the
`unvalidated` flag stays until a Korean reader scores it.

## Parked

**Scoring the Korean→English accuracy — parked 2026-09-27, waiting on a Korean
reader.** Everything above is structural and needed no Korean. Judging whether
a given line *means* the right thing does not, and that is the same wall the
Japanese evaluation hit; it is parked for the same reason and alongside it in
[`reference/`](reference/).

Parked, not abandoned. What is already settled without a reader:

- the premise — YouTube's Korean output is damaged in the English itself (§6)
- the mechanics — segmentation, spacing, turns, all measured (§1–§5)
- the ceiling — clean audio translates coherently, wrecked audio does not, and
  the difference is the ASR rather than anything here (§7, §8)

What a reader would add, and nothing else can: whether a fluent line is
*correct*. That is the one question this project cannot answer about itself in
either language, and it is worth being plain that it is the same gap twice
rather than a Korean-specific shortfall.

**When it resumes**, the work is already laid out: a `ko` fixture pair in the
shape of the Japanese one, scored against the seven-category taxonomy in
[`README.md`](README.md), with the Korean-only categories from §8.5 of the
design doc added — kinship-as-address and speech level.

## Cost estimate, now grounded

| Change | Size |
|---|---|
| Add `.` to `SENTENCE_END` / `SENTENCE_SPLIT` | one character each, measured above |
| Split-joining with a space for spaced languages | small, in `segment()` |
| Hangul in the `CJK` class in `srt.js` | one range |
| Strip and use `>>` as a turn boundary | small, and a genuine quality win |
| Re-tune `maxChars` for Korean density | needs a fixture run |
| Korean prompt, replacing the §3.3 Japanese rules | the real work |
| Korean evaluation set | blocked on a reader |
