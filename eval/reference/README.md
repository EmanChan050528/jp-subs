# Human reference translation

> **Parked — blocked on a Japanese reader.** Both jobs below were attempted and
> set aside: Job B needs Japanese, and Job A turned out to be more work than it
> was worth to someone using the tool rather than building it. Nothing here is
> abandoned; it is waiting on the right person. Until then the quality claims
> stay marked as unverified wherever they appear.

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

## Two different jobs

The worksheet below assumes the person filling it in reads Japanese. If they do
not, it cannot be done — and no amount of supplying a draft translation fixes
that, because a reference derived from the output being scored is circular.

There is a second, narrower job that **does not require Japanese**, and it
happens to target the one category still lost to YouTube.

### Job A — `EmteTL5Ij8g_who-is-it.txt` (no Japanese needed)

Japanese omits the subject of most sentences, so the translator guesses who or
what each line is about. **34 of 78 lines in this fixture assert a subject the
Japanese never states — 44%.** That is the pro-drop exposure, quantified.

Whether each guess is right is a question about what is on screen, which a
viewer can answer and the pipeline cannot. The worksheet shows each guessed
subject in `>>angle brackets<<`; the reply is `ok`, the real referent, or
`unclear`.

This does **not** validate translation quality, and a reference built this way
must never be used to score it. It answers exactly one question: how often the
pro-drop guess is wrong, and in which direction. That is worth knowing on its
own — the design predicted pro-drop as the top quality risk, and it is the only
category still failing.

### Job B — the full worksheet (Japanese needed)

`EmteTL5Ij8g_30-40min.worksheet.txt`, below. Still the only thing that settles
the headline claim, and still blocked on someone who reads Japanese.

Until it is done, "beats YouTube on 5 of 7 categories" remains an internal
measurement, not an independent one, and the READMEs should keep saying so.

## How to do it (Job B)

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

- [ ] **Job A** — referent check filled in (no Japanese needed)
- [ ] Job A scored: how often is the pro-drop guess wrong?
- [ ] **Job B** — full reference translation (blocked: needs a Japanese reader)
- [ ] Job B scored against both outputs
- [ ] `../README.md` claims corrected if the numbers disagree
