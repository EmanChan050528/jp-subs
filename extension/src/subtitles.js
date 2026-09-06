// The subtitle-file translator: a Japanese .srt/.vtt in, an English .srt out.
//
// This is how the project reaches video that is not on YouTube. It buys that
// without any per-site work, because a subtitle file is the same thing the
// interceptor extracts from a YouTube tab — timed cues — so the whole two-pass
// pipeline is reused unchanged. What it does NOT do is draw subtitles over a
// player on another site; that would need per-site player detection, which is
// exactly the cost this avoids.
//
// The pipeline runs HERE, in the page, not in the service worker. A worker is
// killed after ~30 s idle and a long run is minutes of unbroken requests; a
// tab simply lives as long as it is open. The cost is that closing the tab
// ends the run, which the UI says plainly.

import { parseSubtitles, describeCues, toSrt } from "./core/srt.js";
import { segment } from "./core/segment.js";
import { analyse, translateUnits } from "./core/pipeline.js";
import { makeBackend } from "./core/backends.js";
import { loadSettings, formatDuration } from "./shared.js";

const $ = (id) => document.getElementById(id);

/** Below this proportion of Japanese characters, the file is probably wrong. */
const MIN_CJK_RATIO = 0.2;

let cues = null;
let fileName = "";
let controller = null;
let stopped = false;
let result = null;      // { units, translations } — kept so a stopped run is still downloadable

// ------------------------------------------------------------------ plumbing

function message(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = text ? `show ${kind || ""}` : "";
}

function log(line) {
  $("logBox").hidden = false;
  $("log").textContent += `${line}\n`;
  $("log").scrollTop = $("log").scrollHeight;
}

function status(text) {
  $("status").textContent = text || "";
}

function facts(pairs) {
  const list = $("factList");
  list.innerHTML = "";
  for (const [key, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
}

// ---------------------------------------------------------------- file input

function readFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => message(`Could not read ${file.name}.`, "err");
  reader.onload = () => loadSubtitles(file.name, String(reader.result || ""));
  // Subtitle files are almost always UTF-8. Shift-JIS ones exist, but they
  // arrive as mojibake rather than as an error, which the language check below
  // catches and reports.
  reader.readAsText(file, "utf-8");
}

function loadSubtitles(name, text) {
  message("");
  result = null;
  $("download").hidden = true;

  const parsed = parseSubtitles(text);
  if (!parsed.length) {
    cues = null;
    $("facts").hidden = true;
    $("controls").hidden = true;
    message(
      `No subtitles found in ${name}. It needs to be a .srt or .vtt file — ` +
      `a timing line like "00:00:01,000 --> 00:00:04,000" followed by its text.`,
      "err"
    );
    return;
  }

  cues = parsed;
  fileName = name;
  const info = describeCues(parsed);

  facts([
    ["File", name],
    ["Lines", String(info.cues)],
    ["Length", formatDuration(info.durationMs)],
    ["Japanese", `${Math.round(info.cjkRatio * 100)}% of characters`],
  ]);

  $("facts").hidden = false;
  $("controls").hidden = false;
  $("context").value = name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ");

  if (info.cjkRatio < MIN_CJK_RATIO) {
    message(
      `This file does not look like Japanese — only ` +
      `${Math.round(info.cjkRatio * 100)}% of its characters are. Translating ` +
      `it anyway will take just as long and produce nothing useful. If the ` +
      `text looks like garbage, the file is probably Shift-JIS; re-save it as ` +
      `UTF-8 and load it again.`,
      "err"
    );
  }
}

$("file").addEventListener("change", (e) => readFile(e.target.files[0]));
$("drop").addEventListener("click", () => $("file").click());

for (const type of ["dragenter", "dragover"]) {
  $("drop").addEventListener(type, (e) => {
    e.preventDefault();
    $("drop").classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  $("drop").addEventListener(type, () => $("drop").classList.remove("over"));
}
$("drop").addEventListener("drop", (e) => {
  e.preventDefault();
  readFile(e.dataTransfer?.files?.[0]);
});

// ------------------------------------------------------------------ settings

async function fillSettings() {
  const config = await loadSettings();
  $("host").value = config.host;

  const select = $("model");
  try {
    const res = await fetch(`${config.host}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name).sort();

    select.innerHTML = "";
    if (!models.length) {
      select.innerHTML = '<option value="">(none installed)</option>';
      $("modelNote").textContent = "Pull one first, e.g. ollama pull qwen3.5:9b";
      return;
    }
    for (const name of models) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === config.model;
      select.append(option);
    }
    if (!models.includes(config.model)) {
      $("modelNote").textContent = `"${config.model}" is not installed; pick another.`;
    } else {
      $("modelNote").textContent = "Smaller models are faster and less accurate.";
    }
  } catch (err) {
    select.innerHTML = `<option value="${config.model}">${config.model}</option>`;
    $("modelNote").textContent = `Could not list models: ${err.message}`;
  }
}

$("model").addEventListener("change", (e) =>
  chrome.storage.local.set({ model: e.target.value })
);
$("host").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ host: e.target.value.trim() });
  await fillSettings();
});

fillSettings();

// ----------------------------------------------------------------- the run

function running(isRunning) {
  $("go").disabled = isRunning;
  $("stop").hidden = !isRunning;
  $("drop").style.pointerEvents = isRunning ? "none" : "";
  $("drop").style.opacity = isRunning ? "0.5" : "";
}

$("stop").addEventListener("click", () => {
  stopped = true;
  controller?.abort();
  status("Stopping…");
});

$("go").addEventListener("click", async () => {
  if (!cues) return;

  message("");
  $("log").textContent = "";
  $("download").hidden = true;
  stopped = false;
  result = null;
  controller = new AbortController();
  running(true);

  const config = await loadSettings();
  const backend = makeBackend(config.backend, {
    model: $("model").value || config.model,
    host: config.host,
    signal: controller.signal,
  });

  const units = segment(cues);
  log(`segmented ${cues.length} cues into ${units.length} units`);

  // Pass 1 is one long request with no internal progress, and on a slow
  // machine it is the phase that looks like a hang. A climbing counter is the
  // difference between "working" and "frozen".
  const analysisStart = Date.now();
  const ticker = setInterval(() => {
    const seconds = Math.round((Date.now() - analysisStart) / 1000);
    status(
      `Reading the whole transcript… ${seconds}s so far` +
      (seconds > 120 ? " — a large model on a slow machine takes several minutes" : "")
    );
  }, 1000);
  status("Reading the whole transcript…");

  try {
    const glossary = await analyse(
      units, backend, { title: $("context").value.trim() || fileName }, log
    );
    clearInterval(ticker);
    if (stopped) throw new Error("Stopped.");

    const chunkCount = Math.max(1, Math.ceil(units.length / (Number(config.size) || 20)));
    $("bar").max = chunkCount;
    $("bar").value = 0;
    status(`Translating 0/${chunkCount}…`);

    const startedAt = Date.now();
    const { translations, failures, stopped: wasStopped } = await translateUnits(
      units, glossary, backend,
      { ...config, shouldStop: () => stopped },
      log,
      (partial, done, total) => {
        const elapsed = Date.now() - startedAt;
        const remaining = done > 0 ? (elapsed / done) * (total - done) : null;
        $("bar").max = total;
        $("bar").value = done;
        status(
          `Translating ${done}/${total}` +
          (remaining ? ` · ~${formatDuration(remaining)} left` : "")
        );
      }
    );

    result = { units, translations };
    $("download").hidden = false;

    const translated = translations.filter(Boolean).length;
    if (wasStopped) {
      status("");
      message(
        `Stopped. ${translated} of ${units.length} lines were translated — ` +
        `you can still download those.`,
        "ok"
      );
    } else {
      status("");
      message(
        `Done: ${translated} of ${units.length} lines translated in ` +
        `${formatDuration(Date.now() - startedAt)}.` +
        (failures.length ? `\n\n${failures.join("\n")}` : ""),
        failures.length ? "err" : "ok"
      );
    }
  } catch (err) {
    clearInterval(ticker);
    status("");
    if (stopped || /^Stopped\.$/.test(err.message || "")) {
      message("Stopped before anything was translated.", "ok");
    } else {
      message(err.message, "err");
    }
  } finally {
    clearInterval(ticker);
    controller = null;
    running(false);
  }
});

// ------------------------------------------------------------------ download

$("download").addEventListener("click", () => {
  if (!result) return;
  const srt = toSrt(result.units, result.translations);
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName.replace(/\.[^.]+$/, "")}.en.srt`;
  link.click();
  URL.revokeObjectURL(url);
});

// A run lives in this tab, so closing it mid-run throws the work away.
window.addEventListener("beforeunload", (e) => {
  if (controller) e.preventDefault();
});
