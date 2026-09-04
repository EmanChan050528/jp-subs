# Human reference translation

## Why this exists

Every quality claim in `../README.md` — "beats YouTube on 5 of 7 categories" —
was scored by the same party that produced one of the outputs, against a
taxonomy that party wrote. That is suggestive, not evidence. A human
translation of the same lines is what turns it into a measurement.

It is the last thing standing between "this looks better" and "this is better".

## Why it has to be done by hand

Two shortcuts were tried and rejected:

**An LLM reference** is circular — it grades its own kind of work.

**Fansub tracks.** Some YouTube videos genuinely do carry a human English
caption track alongside the Japanese one (`en: manual`, `ja: asr`), and two
were found and pulled. But they are poor gold standards: the English is loose
and localised, carries translator annotations that are not translations of
speech at all (`RULE: If someone says your forbidden word you take damage`),
and does not align 1:1 with the Japanese track — 42 English cues against 30
Japanese on the video sampled. Good subtitles; unusable for line-level scoring.

Worth revisiting if a video turns up with a tight, unannotated English track.

## How to do it

Open `EmteTL5Ij8g_30-40min.worksheet.txt` and fill in the `EN:` lines.

- **78 lines total, but only 14 matter.** Those are marked `(*)` — they are the
  lines carrying the seven failure categories. Doing only those is a valid run.
- Watch the source while you do it:
  <https://www.youtube.com/watch?v=EmteTL5Ij8g&t=1800s> (30:00–40:00). Context
  matters — several lines are about something happening on screen.
- Translate what you would want to **read as a subtitle**, not word-for-word.
- `EN: [skip]` for noise or anything unintelligible.
- Do not look at `../fixtures/*.en.json` first. The point is an independent
  reading.

Twenty minutes for the marked lines; an hour or so for all 78.

## What happens next

The filled worksheet gets scored against three outputs on the same lines:

| | |
|---|---|
| `../fixtures/EmteTL5Ij8g_30-40min.youtube-en.json` | YouTube's auto-translation |
| `../fixtures/EmteTL5Ij8g_30-40min.qwen35-9b-en.json` | this project |
| the worksheet | the reference |

That answers three things the project currently only assumes:

1. Does it actually beat YouTube, or does it just fail differently?
2. Are the seven failure categories the right ones, or an artefact of the
   taxonomy being written by the same party that scored it?
3. How close to a human is it — 90% of the way, or 40%?

## Status

- [ ] Worksheet filled in
- [ ] Scored against both outputs
- [ ] `../README.md` claims corrected if the numbers disagree
