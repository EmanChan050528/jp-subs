# Changelog

Versions were applied retroactively. The dividing line is the first commit at
which the extension actually put subtitles on screen: everything before that is
`0.x`, everything from there on is `1.x`.

Tags are annotated, so `git show 1.0.0` explains why each one is where it is.

---

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
