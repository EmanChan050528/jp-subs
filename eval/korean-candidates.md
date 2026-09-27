# Korean fixture candidates

Verified 2026-09-27 by reading each video's `captionTracks` and
`translationLanguages` out of its watch page. Every entry below has a Korean
ASR track, marked translatable, with English among YouTube's 156 offered
targets — so both halves of the comparison exist: a Korean source track, and
YouTube's own English rendering of it.

The method was validated against this project's own Japanese fixtures first:
`EmteTL5Ij8g` and `NSY6YHXbxtA` both correctly reported `ja/asr`.

## Shortlist

| Video | Channel | Length | Tracks | Why |
|---|---|---|---|---|
| `k9QHpWEX2WA` | 스텔라이브 StelLive | 147 min | `ko/asr` | **Best match.** Korean VTuber agency; multi-member unscripted talk. The direct analogue of the Hololive fixture. |
| `Ejm56jHq3nI` | 침착맨 Chimchakman | 424 min | `ko/asr` | Long-form unscripted gameplay + chat. Closest in *shape* to `EmteTL5Ij8g` (7h53m). |
| `j3pkV71FvYs` | 우왁굳 Woowakgood | 155 min | `ko/asr` | Streamer VOD, watch-along. Woowakgood produces Isegye Idol. |
| `nOdLfDOAMvg` | 슈카월드 | 28 min | `ko/asr`, `en-US/asr`, `id/asr` | **Contrast case, not a baseline.** See caveat. |

## Caveats

**슈카월드 carries `en-US/asr` and `id/asr` tracks of its own.** Those are
recognition of separate dubbed audio, not translation of the Korean, so the
comparison there is not like-for-like. It is also a semi-scripted economics
monologue — the *easy* profile. Useful only as a contrast: if this project
cannot beat YouTube on clean scripted speech, the answer is decisive.

**Isegye Idol's own channel is mostly music videos and shorts**, which have no
caption tracks at all (`ANXZAUmT3q4`, 218 s: none). The unscripted long-form
content lives on the members' and Woowakgood's channels, not the group one.

## Caption access behaves exactly as it does for Japanese

Fetching the `ko` track's `baseUrl` straight out of the watch page returns
**HTTP 200 with a zero-byte body** — the same silent refusal documented in
§0.3.0 for Japanese. The proof-of-origin token is required for Korean too, so
the interceptor approach transfers unchanged. It also means the caption content
cannot be collected without either the extension or yt-dlp.

## Still unanswered: does Korean ASR emit punctuation?

This is the question that decides whether Korean segmentation is a patch or a
redesign, and it cannot be answered without the actual caption text — see
`korean-readiness.mjs`, which shows that the sentence-end rule already fails on
the ASCII period Korean uses. If Korean ASR emits no terminal punctuation at
all, sentence-level segmentation has nothing to work from.

## Collecting a fixture pair

```bash
# See exactly what is on offer first; the naming of auto-translated tracks
# varies and is worth reading rather than guessing.
yt-dlp --list-subs "https://www.youtube.com/watch?v=k9QHpWEX2WA"

# Korean source + YouTube's English, as .srt
yt-dlp --write-auto-subs --sub-langs "ko,en" --skip-download \
       --convert-subs srt "https://www.youtube.com/watch?v=k9QHpWEX2WA"
```

Then cut a ~10-minute window from the middle of both, aligned by timestamp, to
match how `EmteTL5Ij8g_30-40min` was built.
