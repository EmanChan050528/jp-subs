# JP Subs

English subtitles for Japanese YouTube videos, translated on your own machine.

The extension reads the video's Japanese caption track, translates it with a
local LLM, and draws the result over the player. Nothing is uploaded, there is
no API key, and it costs nothing per video.

It is aimed at the content YouTube handles worst — VTuber archives and anime —
where the built-in auto-translation drops context and mangles pronouns.

---

## What you need

| | |
|---|---|
| **Chrome** | or any Chromium browser (Edge, Brave). Version 111+ |
| **[Ollama](https://ollama.com/download)** | running locally — this is what does the translating |
| **A model** | `qwen3.5:9b` recommended, ~6 GB download |
| **A GPU** | not required, but a slow CPU means a slow translation |

**Ollama is required.** The extension has no cloud fallback and will not work
without it. If you have never used Ollama, the installer from
[ollama.com/download](https://ollama.com/download) is all the setup it needs —
it runs as a background service once installed.

The video also needs a **Japanese caption track**. Nearly all Japanese YouTube
content has one (auto-generated is fine and is the normal case). Videos with no
Japanese track are not supported.

---

## Setup

### 1. Get a model

```bash
ollama pull qwen3.5:9b
```

Any Ollama model works and you can switch later in the extension, but this one
is a good default: it is strong at Japanese, fits comfortably in 12 GB of VRAM,
and has a large context window. `qwen3.5:4b` is a smaller, faster, less accurate
alternative.

### 2. Let Ollama accept the extension

This step is easy to miss and nothing will work without it. Ollama rejects
requests from origins it does not recognise, and browser extensions are not on
its default list — it answers `403` with no useful message.

**Windows**

```bash
setx OLLAMA_ORIGINS "chrome-extension://*"
```

**macOS**

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
```

**Linux** — add `Environment="OLLAMA_ORIGINS=chrome-extension://*"` to the
`ollama` systemd unit, or export it before running `ollama serve`.

Then **fully quit and restart Ollama** (tray icon → Quit, not just closing the
window). The variable is only read at startup.

### 3. Load the extension

1. Download or clone this repository
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the **`extension/`** folder
5. Open a Japanese YouTube video, then **reload the tab**

> **The reload in step 5 matters.** The extension has to attach before YouTube's
> player finishes starting up. A tab that was already open when you loaded the
> extension will not work until you refresh it.

---

## Using it

Click the **JP Subs** icon in the toolbar. The popup tells you what it found:

```
#10【ほの暮しの庭】ストーリーは最終回へ
Duration    473 min
Tracks      ja (asr)
Japanese    auto-generated
```

If **Japanese** shows a track, press **Translate & show subtitles**.

**What happens next**

1. It grabs the caption track — a second or two
2. It reads the whole transcript once, to work out who is speaking, what the
   video is about, and which names and terms recur
3. It translates in chunks, and **subtitles start appearing after the first
   chunk** rather than at the end
4. A small progress box sits in the top-right of the video —
   `Translating 12/47 · ~2m 30s left`

You can switch tabs, minimise the browser, or close the popup while it runs.
Just leave that YouTube tab open — navigating it to a different video cancels
the run.

**How long it takes** (measured with `qwen3.5:9b` on an RTX 5070):

| Video | Time |
|---|---|
| 24-minute anime episode | ~1 minute |
| 1-hour stream | ~2 minutes |
| 8-hour archive | ~17 minutes |

Roughly 28× faster than real time, so the end of a video is usually translated
long before you reach it.

When it finishes, the button changes to **Subtitles applied**. The result is
saved, so **opening that video again is instant and free**.

---

## Settings

Open the popup and expand **Settings**.

**Ollama model** — lists every model you have installed. Model choice is the
only real speed lever; chunk sizes and context widths were measured making
almost no difference.

**Ollama host** — change if Ollama runs somewhere other than
`http://localhost:11434`.

**Cached translations** — shows how much space finished translations use.
The cache holds about 14 long VODs, or a couple of hundred anime episodes,
and drops the least recently used ones when full. **Clear cache** empties it.

### Channel glossary

Names and recurring terms are remembered **per channel** and reused on the next
video from that channel, so a streamer is not romanised differently every time.

This makes names *consistent*, not automatically *correct* — whatever the first
video decided gets carried forward. Expand **Channel glossary** in the popup to
fix one:

```
フレ = Flare
不知火フレア = Shiranui Flare
```

One entry per line, `japanese = english`. Delete a line to remove the entry.
Changes apply to the next translation on that channel — press **Re-translate**
to redo the current video with them.

---

## Other buttons

**Stop translating** — appears while a run is going. Stops within a few
seconds; whatever was already translated stays on screen.

**Re-translate** — ignores the cached result and translates the video again.
Use it after editing the glossary or switching models.

**Download .srt** — saves the English subtitles as a standard `.srt` file, so
they can be used in VLC, mpv, or anywhere else. Appears once a video has been
translated, and works from the cache too.

**Save transcript only** — downloads the raw Japanese transcript as JSON
without calling the model at all.

---

## Good to know

- **Overlapping speech gets jumbled.** YouTube's speech recognition produces one
  undifferentiated stream with no speaker labels, so nothing downstream can
  separate two people talking at once.
- **Subtitles are hidden during ads** and reappear afterwards.
- **YouTube's own captions are switched off again** after the extension borrows
  them during setup.
- **It only handles Japanese → English**, and only on YouTube videos that
  already have a caption track.

---

## Why not just use YouTube's auto-translation?

Because it translates each caption line on its own, with no idea what came
before or after. Measured against it on a real VTuber archive:

| Japanese | YouTube | JP Subs |
|---|---|---|
| 大会は対人系は参加あんまりしない | "I participate in tournaments that involve playing against other people." | "I don't participate in many PvP tournaments" |
| 私の調子と相談して | "Consult with your doctor" | "I'll decide based on my condition" |
| 配信 | "delivery" | "stream" |
| 仕様 | "specification" | "It's a game mechanic." |

The first row is the one that matters: YouTube states the **opposite** of what
was said, because the negation falls in the next caption line and it never sees
it.

**A caveat on these comparisons.** They were scored in-house, against a list of
failure categories written by the same party that produced one of the outputs.
No independent Japanese speaker has checked them. The examples above are real
and reproducible from the files in [`eval/`](eval/), but treat "beats YouTube on
5 of 7 categories" as an internal measurement rather than a verified result.
Full scoring, including the cases this project still gets wrong, is in
[`eval/README.md`](eval/README.md).

---

## Repository layout

| | |
|---|---|
| [`extension/`](extension/) | the Chrome extension — load this one |
| [`core/`](core/) | command-line version of the translator, for testing |
| [`eval/`](eval/) | test fixtures and quality scoring |
| [`docs/`](docs/) | notes on translation backends |
| [`translator-design.md`](translator-design.md) | design decisions and the reasoning behind them |

---

## Troubleshooting

**"Ollama refused the request (403)"** — step 2 was missed, or Ollama was not
restarted afterwards.

**"Could not reach the page"** — reload the YouTube tab.

**"This video has no Japanese caption track"** — exactly that; there is no
speech-recognition fallback.

**Nothing appears and no error** — check the extension's service worker console
(`chrome://extensions` → JP Subs → **service worker**) and the page console for
lines starting `[jpsub]`.
