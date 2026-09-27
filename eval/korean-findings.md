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

## Still open

**The comparison against YouTube's own English.** The `en` auto-translated
track for this video is available (`yt-dlp --list-subs` lists `en`, `ko`,
`ko-orig`) but repeated fetches drew HTTP 429. It needs a retry after a
cooldown.

**Scoring.** Even with both tracks, judging the output needs a Korean reader —
the same wall the Japanese evaluation hit. The structural findings above are
all countable and need no language knowledge; quality is not.

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
