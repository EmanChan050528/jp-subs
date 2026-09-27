// Prompt construction, per language.
// Run: node extension/src/prompt.test.mjs
//
// These assert on structure, not on wording: that the right language's rules
// are selected, that generic rules are not forked per language, and that the
// speaker-turn data from segment.js actually reaches the model. Whether the
// Korean rules are GOOD is not testable here — see eval/korean-findings.md.

import { createHash } from "node:crypto";
import { analysisPrompt, translationPrompt } from "./core/prompt.js";

let failed = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}\n       want ${w}\n       got  ${g}`); }
};

const unit = (ja, turn = false) => ({ ja, start_ms: 0, end_ms: 1000, turn });

const chunk = (target, firstUnit = 0) => ({
  target, firstUnit, before: [], after: [], index: 0,
});

console.log("\n--- analysis pass picks its language ---");

const jaAnalysis = analysisPrompt("こんにちは", { source_lang: "ja" });
const koAnalysis = analysisPrompt("안녕하세요", { source_lang: "ko" });

check("Japanese analysis names Japanese",
  jaAnalysis.includes("translate a Japanese video transcript"), true);
check("Korean analysis names Korean",
  koAnalysis.includes("translate a Korean video transcript"), true);
check("Korean analysis does not mention Japanese",
  koAnalysis.includes("Japanese"), false);
check("Korean analysis carries its own ASR cause",
  koAnalysis.includes("Sino-Korean homophones"), true);
check("Korean analysis warns about romanisation",
  koAnalysis.includes("romanisation"), true);
check("an unknown language falls back to Japanese",
  analysisPrompt("...", { source_lang: "de" }).includes("Japanese video transcript"), true);
check("a missing language falls back to Japanese",
  analysisPrompt("...", {}).includes("Japanese video transcript"), true);

console.log("\n--- translation pass picks its language ---");

const jaPrompt = translationPrompt(chunk([unit("こんにちは。")]), {}, null, { lang: "ja" });
const koPrompt = translationPrompt(chunk([unit("안녕하세요.")]), {}, null, { lang: "ko" });

check("Japanese header", jaPrompt.includes("Translate Japanese video dialogue"), true);
check("Korean header", koPrompt.includes("Translate Korean video dialogue"), true);

check("Japanese rules are used for Japanese",
  jaPrompt.includes("Japanese omits subjects constantly"), true);
check("Korean rules are used for Korean",
  koPrompt.includes("Korean omits subjects constantly"), true);
check("Korean does not receive the Japanese rules",
  koPrompt.includes("Japanese omits subjects"), false);

// The Korean-only category: kinship words are address, not family.
check("Korean warns about kinship terms as address",
  koPrompt.includes("forms of address"), true);
check("Japanese does not carry the kinship rule",
  jaPrompt.includes("forms of address"), false);

console.log("\n--- generic rules are shared, not forked ---");

for (const fragment of [
  "Use the reference sheet for names and terms",
  "Never invent content that is not in the source",
  "Translate ONLY the numbered lines",
  "No leading or trailing ellipses",
]) {
  check(`both languages carry: ${fragment.slice(0, 34)}…`,
    [jaPrompt.includes(fragment), koPrompt.includes(fragment)], [true, true]);
}

// Rules are numbered by position, so a language with more of them must not
// leave a gap or repeat a number.
const numbersIn = (prompt) => {
  const body = prompt.split("Rules:\n")[1].split("\n\n")[0];
  return body.split("\n").map((l) => Number(l.split(".")[0]));
};
check("Japanese rules are numbered 1..10", numbersIn(jaPrompt),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
check("Korean rules are numbered 1..12", numbersIn(koPrompt),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

check("the length rule names the right source language",
  [jaPrompt.includes("its Japanese source"), koPrompt.includes("its Korean source")],
  [true, true]);

console.log("\n--- speaker turns reach the model ---");

const withTurns = translationPrompt(
  chunk([unit("그래서 내가"), unit("아니야", true), unit("맞아")]), {}, null, { lang: "ko" }
);
check("turn lines are listed", withTurns.includes("NEW SPEAKER STARTS AT LINES: 2"), true);

const noTurns = translationPrompt(
  chunk([unit("그래서 내가"), unit("아니야")]), {}, null, { lang: "ko" }
);
check("no speaker section when the track marks none",
  noTurns.includes("NEW SPEAKER"), false);

// A retry resends a subset; the speaker list must not name lines that are
// not in that subset, or it points at numbers the model was never given.
const subset = translationPrompt(
  chunk([unit("그래서 내가"), unit("아니야", true), unit("맞아")]), {},
  [{ n: 3, ja: "맞아" }], { lang: "ko" }
);
check("a retry subset drops turn lines it did not ask for",
  subset.includes("NEW SPEAKER"), false);

console.log("\n--- the echo contract still holds ---");
const echoed = translationPrompt(chunk([unit("안녕하세요.")]), {}, null, { lang: "ko", echo: true });
check("echo asks for the source copied back", echoed.includes('"ja"'), true);
check("the speaker note does not contaminate the copied line",
  echoed.includes('"ja": "안녕하세요."'), true);

console.log("\n--- the Japanese prompts must not drift ---");

// Every Japanese rule traces to a scored failure category, and this file's
// header says wording changes need a fixture run behind them. Parameterising
// the prompt for Korean silently reworded the analysis pass once already —
// caught by diffing against the previous commit, not by any test.
//
// If one of these fails, either the change was unintended, or it was intended
// and needs evidence. Re-running the fixtures and updating the hash in the
// same commit is the intended workflow; updating the hash alone is not.
const snapshot = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const jaChunk = chunk([unit("こんにちは。"), unit("元気ですか？")]);
jaChunk.before = [unit("前の行")];
jaChunk.after = [unit("次の行")];
const jaGloss = {
  setting: "test", names: { "フレア": "Flare" }, terms: {},
  asr_corrections: {}, register: "casual",
};
const jaMeta = { title: "T", author: "A", source_lang: "ja" };

check("analysis pass unchanged",
  snapshot(analysisPrompt("こんにちは", jaMeta)), "888a29cb97ac7051");
check("translation pass unchanged",
  snapshot(translationPrompt(jaChunk, jaGloss, null, { lang: "ja" })), "7f7a0d72faf4bf36");
check("translation pass (echo) unchanged",
  snapshot(translationPrompt(jaChunk, jaGloss, null, { lang: "ja", echo: true })),
  "634e7723c63eb3d7");

console.log(failed ? `\n${failed} failing` : `\nall passing`);
process.exit(failed ? 1 : 0);
