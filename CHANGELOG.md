# Changelog

Versions were applied retroactively. The dividing line is the first commit at
which the extension actually put subtitles on screen: everything before that is
`0.x`, everything from there on is `1.x`.

Tags are annotated, so `git show 1.0.0` explains why each one is where it is.

---

## Unreleased — lines stay on their own subtitle

Ported back from [whisper-subs](https://github.com/EmanChan050528/whisper-subs),
where it was found and measured.

On fragmented speech the model would rebuild whole sentences and spread the
English across the line numbers, putting each translation on a neighbouring
subtitle. Every line still "has a translation", so nothing flagged it. Pass 2
now asks for `{"n": {"ja": "<the line, copied>", "en": "..."}}`. Writing the
line out right before its English anchors the translation to it, and a copy
that doesn't match its line is rejected and asked for again.

- On whisper-subs' hour-long conversation a chunk shifted in 3 of 3 runs with
  the old format and was aligned in 3 of 3 with this one.
- Here, on `EmteTL5Ij8g` 30–40 min (the most fragmented fixture), the old
  format shifted lines 8–14, so each showed the next line's English
  (「あれ?」 → "Are there three of them?"). With echo there was one 2-line
  fold and no run of wrong lines. Checked with whisper-subs' `eval/align.py`.
- Cost: more output tokens, so 57 s instead of 37 s on that fixture.
- On by default (extension settings `echo`, CLI `--no-echo` to turn it off).
  The core's default is off, so `translateUnits` without the option behaves
  exactly as before. whisper-subs' byte-for-byte parity tests confirm the
  plain path is unchanged and cover the echo path too.
- Copying only the first few characters of each line was tried in whisper-subs
  and made shifts worse.

---

## 1.11.0 — Ollama health check

Ollama is a separate program people close, and the old failure mode was to
start a run, extract the whole transcript, and only then hit the model call and
die. The popup now probes before anything starts and disables **Translate**
until the backend is actually usable.

Four states, because they need four different fixes and collapsing them sent
people to reinstall something already running:

| State | Fix offered |
|---|---|
| Not running | `ollama serve` |
| Running, refused (403) | the `OLLAMA_ORIGINS` line for your platform |
| Running, no models | `ollama pull qwen3.5:9b` |
| Selected model missing | `ollama pull <that model>` |

Each comes with a **Copy command** button and a **Check again** button, so
starting Ollama and retrying does not mean reopening the popup.

**There is no "start Ollama" button, and there cannot be.** A web page cannot
launch a local program — that is a browser security boundary, not an
oversight. Copying the command is the nearest honest thing. Doing it properly
would need a native messaging host, which is a separate program to install,
which is the problem it would be solving.

The check runs *after* the cache lookup, so a video that is already translated
still shows its subtitles with Ollama closed.

Fixes a latent bug found while wiring this: the run-state poll called the
**language** gate, so a poll could re-arm Translate for a language that cannot
be translated. Language, run state and backend health are now three separate
flags behind one paint function, rather than three writers racing on
`disabled`.

## 1.10.0 — Korean translation

Step 3, and Korean now translates. **Its quality has not been checked by a
Korean reader**, and the popup says so rather than presenting Korean and
Japanese as equally trustworthy.

`prompt.js` carries a per-language rule set. Japanese has three
language-specific rules, Korean five: the same pro-drop, verb-final polarity
and fragment categories with different mechanics, plus two Korean-only ones.
Kinship terms (오빠, 형, 누나, 선배, -님) are forms of address, and rendering
them literally invents siblings. Speech level — 반말 against 존댓말 — carries
the relationship and belongs in the English tone, not in a note.

Pro-drop gets mitigations Japanese cannot offer: the honorific infix -시- marks
the subject as someone the speaker defers to, and the `>>` turn boundaries
found in 1.8.0 now reach the model as a list of line numbers. Sent separately
rather than inline, so the echoed source copy still matches exactly, and a
retry that resends part of a chunk does not name lines it never asked for.

Everything language-neutral — output shape, length limits, the bans on
inventing content and on translating the context — stays in one shared list,
because duplicating it per language is how two prompts drift apart.

Worth recording: parameterising the prompt silently reworded the *Japanese*
analysis pass, which this file's own rule forbids without a fixture run behind
it. Caught by diffing against the previous commit, not by a test. The Japanese
prompts are now snapshot-hashed so the next parameterisation cannot repeat it.

**Since release, from use.** Korean is coherent on clean single-speaker audio
and incoherent on a multi-speaker archive whose caption track the speech
recognition had already wrecked. Same prompt, same pipeline, opposite results,
and the variable was the input — so the binding constraint on Korean is the
ASR, not the translator. The README now states this as *content* guidance
rather than a language caveat, because it applies to Japanese identically.
Coherent is still not accurate, and the `unvalidated` flag stays.

## 1.9.0 — language plumbing

Step 2 of the Korean expansion. Still not Korean translation — but the
extension stops pretending Korean videos have no captions.

The interceptor no longer hardcodes `lang=ja`. It picks a source track by
priority (Japanese first, so a video carrying both still translates) and
rewrites the signed URL to whatever it found. This needed no new mechanism:
`sparams` never covered `lang`, so extraction was always language-agnostic and
only the hardcoded string made it look otherwise.

That splits one capability into two, which `core/languages.js` now records
separately. **Korean captions can be extracted today** — `Save transcript only`
works on them, which is a far better way to collect Korean fixtures than
fighting yt-dlp's rate limits. Translating them is refused, with the reason,
because the prompt for it is not written.

A Korean video now reports "Korean, auto-generated — cannot be translated yet"
instead of "no Japanese caption track", which was true and useless.

Not done deliberately: no language parameter was threaded into `prompt.js`.
There is one value it could take today. It gets threaded in step 3, when there
are two.

## 1.8.0 — Korean groundwork

Step 1 of the Korean expansion: the mechanical fixes, all provable against the
committed fixtures without knowing Korean. Not Korean support — the prompt is
still Japanese and the extension still only requests a `ja` track.

`SENTENCE_END` carried the fullwidth period but not the ASCII one Korean uses,
so Korean statements never closed a unit. One character, plus a `(?!\d)` guard
on the split rule so "3.5" does not break in half. Korean units over twelve
seconds on screen fell from 207 to 18, and the median from 9.0 s to 4.1 s.

The `CJK` regex was answering two questions that only have the same answer for
Japanese — "does this boundary need a space?" and "is this the source
language?" Hangul is a source script written *with* spaces, so it splits into
two predicates in `core/script.js`.

`>>` speaker markers are stripped and turned into unit boundaries; units carry
`turn`. 2,050 of them on the Korean fixture, none on either Japanese one. This
is the only speaker signal any caption track provides.

`maxChars` was expected to need re-tuning and does not: the 64-char cap binds
on 0.7% of Korean units against 6.4% of Japanese ones.

A near-miss is recorded in the design doc. The first spacing rule kept Japanese
unit counts at exactly 78 and 235 while changing the text underneath —
「もう1回」 became 「もう 1回」. Japanese embeds ASCII without spaces. The tests
now assert on content rather than cardinality, because cardinality passed.

## 1.7.0 — subtitle files

Japanese `.srt`/`.vtt` in, English `.srt` out, in its own tab. This is how the
project reaches video that is not on YouTube, and it costs no per-site work:
a subtitle file is the same thing the interceptor already extracts — timed
cues — so the two-pass pipeline is reused unchanged. It does *not* draw
subtitles over other sites' players; that would need the per-site player
detection this deliberately avoids.

The run lives in the page rather than the service worker, which removes the
MV3 lifetime question from this path entirely.

One parser decision earned its place: rolling captions, the scrolling kind an
auto-generated track produces, repeat the previous cue's text at the top of the
next one. Left alone that is the same sentence translated two or three times.
They are collapsed on the way in — but only when the cues overlap in time,
which is what keeps genuine repetition intact. The test suite caught that
distinction being missed: without the overlap check, a word said twice nine
seconds apart merged into one ten-second subtitle and an utterance was lost.

## 1.6.0 — quality of life

Hide/show subtitles without discarding the translation. Glossary corrections
applied to cached subtitles instantly, with no re-translation. Popup state read
from durable storage instead of the worker's in-memory map, which MV3 wipes
after ~30 s idle — that was why reopening the popup lost the button state. Every
async button now reports that it is working.

## 1.5.0 — `.srt` export

Subtitles can leave the browser. Built in the worker, because `srt.js` is an ES
module and content scripts cannot import one.

## 1.4.0 — readable lines, and a way out

Over-long translations split across their own time span rather than overflowing:
lines above 84 characters fell from 5.9% to 0.1% with no text lost. A Stop
button for a run in progress.

## 1.3.0 — per-channel glossary

Names and recurring terms accumulate per channel and seed the analysis pass, so
a streamer is not romanised differently every video. Editable from the popup,
because seeding makes a name consistent rather than correct.

## 1.2.0 — caching and cancellation

Finished translations cached per video with a bounded LRU, so a re-watch is
instant. Navigating a tab to another video cancels its run — previously the old
run kept painting its subtitles onto the new video.

## 1.1.0 — timing and pacing

Sentence splits anchored to YouTube's word-level timings instead of estimated
from character counts: 22 of 78 unit starts moved, the worst by 4.3 s, and
out-of-order units on a long video went from 172 to 0. Reading-speed pacing, a
remaining-time estimate, and the progress box moved out of the subtitle band.

## 1.0.0 — first working subtitles

The first commit at which the whole thing ran end to end and put English on the
video.

Getting here took two rounds of fixes after the rendering code was written. The
last of them was the one that mattered: a failed analysis pass used to throw and
abort the entire run, so one malformed reply cost every subtitle rather than
just the glossary.

---

## 0.7.0 — rendering, written but not working

Extension and translation core joined; overlay, progress, and worker pipeline
all in place. Produced no visible subtitles on the first real run.

## 0.6.0 — quality validated

`qwen3.5:9b` measured against YouTube's own auto-translation on a real VTuber
archive. Also fixed reasoning-model handling: Qwen3.5 spent its whole output
budget thinking and returned an empty message.

## 0.5.0 — translation core

Two-pass pipeline: a glossary built from the whole transcript, then chunked
translation with forward *and* backward context. Segmentation works at sentence
level because cue granularity varies enormously between videos.

## 0.4.0 — transcript extraction

The extension shell, built first because it was the riskiest part. Worked on the
first browser load.

## 0.3.0 — caption access proven

The gating question answered: caption *content* needs a proof-of-origin token,
and without it the endpoint returns HTTP 200 with an empty body — a silent
refusal. Also established that author-supplied Japanese tracks essentially do
not exist for this content (0 of 20 sampled).

## 0.2.0 — scope locked

YouTube VOD only, Japanese to English. Live streams deferred to an appendix
rather than carried in the design.

## 0.1.0 — design document

Pipeline design, before any code.
