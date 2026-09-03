# Translation backends — setup

**Status: not needed yet.** Nothing in build step 1 (extension shell, transcript extraction) touches a translation backend. Set one of these up when you start build step 2 — the CLI that turns a Japanese transcript into English.

Decision: **Gemini API first, local Qwen as backup.** The Claude API is billed separately from a Claude Pro subscription and was not purchased.

Verified against live documentation on 2026-09-03. Model IDs and SDK shapes in this space change fast — re-check before copying anything here into code.

---

## Why this reverses an earlier decision

The design doc previously dropped the local-model fallback and argued against a pluggable backend interface as speculative generality. That reasoning was **cost-based**: Claude was so cheap per episode that a second backend earned nothing.

The constraint has changed from cost to **access**. Two real backends are now chosen, not hypothesised, so a thin seam between "produce translation units" and "call a model" is justified. Keep it thin — one function that takes chunks and returns translations. Do not build a plugin architecture.

The two-pass structure (§3.1: glossary extraction, then translation with forward context) is what produced the quality gap measured in [../eval/README.md](../eval/README.md). That is a property of the *method*, not of Claude, and should carry across to either backend. Re-run the eval fixtures against whichever backend you pick before trusting it.

---

## Option A — Gemini API (primary)

### 1. Get a key

Create one at [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) (click "Create API key"). No card required for the free tier.

Set it in your own terminal so it stays out of any transcript:

```bash
setx GEMINI_API_KEY "your-key-here"
```

`setx` persists for new processes; reopen the shell afterwards.

### 2. Install the SDK

The package was renamed — `google-genai` is current, **not** the older `google-generativeai`:

```bash
pip install -U google-genai
```

For a Node CLI instead: `npm install @google/genai`

### 3. Minimal call

The current API uses `interactions.create`, not the older `generate_content`:

```python
from google import genai

client = genai.Client()  # reads GEMINI_API_KEY from the environment
interaction = client.interactions.create(
    model="gemini-3.8-flash",
    input="Translate to English: 配信で対人ゲームはやりたくない",
)
print(interaction.output_text)
```

### 4. Free tier caveats — read before using real data

- **Free tier content is used for training.** Google's terms state that for unpaid services "Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products," and that "human reviewers may read, annotate, and process your API input and output." The paid tier explicitly does not do this.
  - For this project that is **low risk** — the input is publicly available YouTube captions, not private data. But know it, and do not point this pipeline at anything private while on the free tier.
- **Rate limits are not published as fixed numbers** and vary by model and account. Check your live limits at [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit). This matters: a long VTuber archive is many chunk requests, and a free-tier requests-per-day cap is the most likely thing to stop a batch job halfway. Design the CLI to **checkpoint and resume** rather than restart.

### 5. Design opportunity Gemini opens

Gemini's context window is very large. The entire 7h53m transcript measured in §1.3 is ~75,000 Japanese characters — comfortably inside a single request.

That means the two-pass design could become **one pass over the whole video** instead of ~570 chunked requests with overlapping context. Fewer requests is also the right shape for a per-day rate limit. Worth testing early:

- [ ] Does whole-transcript-in-one-request beat chunked-with-overlap on the eval fixtures?
- [ ] Does it stay within the free tier's per-request and per-day limits?

---

## Option B — Local Qwen (backup)

No API key, no rate limits, no data leaving the machine, no per-token cost. Slower, and quality needs verifying against the eval set.

### 1. Install Ollama

Download the Windows installer from [ollama.com/download](https://ollama.com/download).

### 2. Pick the model — sized for this machine

This machine has an **RTX 5070 with 12 GB VRAM** and 31 GB system RAM.

[Qwen3.5](https://ollama.com/library/qwen3.5) is the right family: it advertises support for 201 languages and is benchmarked on WMT24++ translation, and **every size carries a 256K context window** — which suits document-level translation directly.

| Tag | Download | Fits in 12 GB VRAM? | Verdict |
|---|---|---|---|
| `qwen3.5:4b` | 3.4 GB | Yes, easily | Fallback if 9B is too slow |
| `qwen3.5:9b` | 6.6 GB | **Yes, with room for context** | **Start here** |
| `qwen3.5:27b` | 17 GB | No — partial CPU offload | Try if 9B quality is insufficient; noticeably slower |
| `qwen3.5:35b`+ | 24 GB+ | No | Not practical here |

```bash
ollama pull qwen3.5:9b
```

- [ ] **Context length costs VRAM.** The 256K window is a ceiling, not free — the KV cache for a full 256K context will not fit in 12 GB. Chunked translation (~20 lines plus overlap) is fine; whole-video single-pass is not. Size the context to the chunk and measure.

### 3. Call it

Ollama serves an OpenAI-compatible endpoint on `http://localhost:11434/v1`, so any OpenAI client library works by pointing `base_url` at it with a dummy key. Confirm the exact path against Ollama's current docs when you wire it up.

Quick manual check first:

```bash
ollama run qwen3.5:9b
```

### 4. What to verify before trusting it

- [ ] Run the [eval fixtures](../eval/fixtures) through it and compare against `EmteTL5Ij8g_30-40min.claude-en.json`
- [ ] Check specifically whether it holds the seven failure categories in [../eval/README.md](../eval/README.md) — especially pro-drop attribution and polarity, which need genuine context use rather than fluent output
- [ ] Time a full 24-minute episode; local inference speed decides whether translate-ahead-of-playhead (§0.3) is achievable

---

## Recommended order

1. Start with **Gemini free tier** — no install, no hardware limits, and the large context may simplify the design.
2. Run the eval fixtures through it before writing any pipeline code. If it does not clear the baseline in `eval/README.md`, that is worth knowing on day one.
3. Pull **Qwen3.5:9b** as the fallback for when rate limits bite, and to have an offline path.
4. Keep the seam between the two thin.

## Sources

- [Gemini API quickstart](https://ai.google.dev/gemini-api/docs/quickstart)
- [Gemini API terms — data use](https://ai.google.dev/gemini-api/terms)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Qwen3.5 on Ollama](https://ollama.com/library/qwen3.5)
- [Qwen3 on Ollama](https://ollama.com/library/qwen3)
