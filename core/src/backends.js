// The model seam. Deliberately one function per backend, not a plugin system.
//
// A backend is: async (prompt, {json}) => string
//
// Ollama is the primary path and needs no dependencies. Gemini is the fallback
// and is NOT yet verified against a live endpoint — see the note on it.

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

/**
 * Local Qwen (or any Ollama model).
 *
 * Two settings here are load-bearing, both learned the hard way:
 *
 * num_ctx — Ollama defaults to a small context that will silently truncate a
 * chunk carrying context units, producing quietly worse output rather than an
 * error.
 *
 * think — Qwen3.5 is a reasoning model. Left on, it emits its reasoning into a
 * separate `thinking` field that consumes the whole num_predict budget before
 * any answer is produced, and `content` comes back EMPTY. Translation does not
 * need extended reasoning, and turning it off is also several times faster.
 * Harmless on models that do not support it.
 */
export function ollamaBackend({
  model = "qwen3.5:9b",
  numCtx = 16384,
  numPredict = 8192,
  temperature = 0.2,
  think = false,
} = {}) {
  return async function ollama(prompt, { json = false } = {}) {
    let res;
    try {
      res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think,
          format: json ? "json" : undefined,
          options: { temperature, num_ctx: numCtx, num_predict: numPredict },
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err) {
      throw new Error(
        `Cannot reach Ollama at ${OLLAMA_HOST}. Is it running? ` +
        `Start it with "ollama serve", then "ollama pull ${model}". (${err.message})`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new Error(
          `Ollama has no model "${model}". Pull it first: ollama pull ${model}`
        );
      }
      throw new Error(`Ollama returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data?.message?.content;

    if (!text) {
      const thinking = data?.message?.thinking || "";
      if (thinking) {
        throw new Error(
          `${model} produced ${thinking.length} characters of reasoning but no ` +
          `answer — it ran out of output budget while thinking. Raise ` +
          `numPredict (currently ${numPredict}) or keep think:false.`
        );
      }
      throw new Error(
        `Ollama returned an empty message (done_reason: ${data?.done_reason || "unknown"}).`
      );
    }
    return text;
  };
}

/**
 * Gemini fallback.
 *
 * UNVERIFIED. The call shape follows Google's current quickstart
 * (client.interactions.create with `input`, reading `output_text`), which was
 * checked on 2026-09-03, but this code path has never been run. Expect to fix
 * it on first use. Requires: npm install @google/genai, and GEMINI_API_KEY set.
 */
export function geminiBackend({ model = "gemini-3.8-flash" } = {}) {
  let client = null;

  return async function gemini(prompt) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in the environment.");
    }
    if (!client) {
      let mod;
      try {
        mod = await import("@google/genai");
      } catch {
        throw new Error(
          "The Gemini backend needs its SDK: npm install @google/genai"
        );
      }
      client = new mod.GoogleGenAI({});
    }

    const interaction = await client.interactions.create({ model, input: prompt });
    const text = interaction?.output_text;
    if (!text) throw new Error("Gemini returned no output_text.");
    return text;
  };
}

export function makeBackend(name, options = {}) {
  if (name === "ollama") return ollamaBackend(options);
  if (name === "gemini") return geminiBackend(options);
  throw new Error(`Unknown backend "${name}". Use "ollama" or "gemini".`);
}

/**
 * Models wrap JSON in prose or code fences no matter how firmly you ask them
 * not to. Recover the object rather than failing the whole chunk.
 */
export function parseJson(text, what = "response") {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
  ];

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.trim());
    } catch { /* try the next shape */ }
  }

  throw new Error(
    `Could not parse JSON from the ${what}. First 300 characters:\n${text.slice(0, 300)}`
  );
}
