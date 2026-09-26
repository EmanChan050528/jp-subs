// Tests for the echo reply format in core/pipeline.js and core/prompt.js.
// Run: node extension/src/echo.test.mjs

import { echoMatches, translateUnits } from "./core/pipeline.js";
import { translationPrompt } from "./core/prompt.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// --- echoMatches
check("exact copy matches", echoMatches("良くないことだと思っていました", "良くないことだと思っていました"));
check("copy with punctuation dropped matches", echoMatches("こんにちは、藤森翔です。", "こんにちは藤森翔です"));
check("a neighbour's line does not match",
      !echoMatches("良くないことだと思っていました", "どうしてそう思ってましたか"));
check("a missing copy does not match", !echoMatches("お金持ちが", undefined));

// --- prompt: plain replies unchanged, echo replies show the copy format
const chunk = { firstUnit: 0, before: [], after: [], target: [{ ja: "昔は" }, { ja: "ニュースを見て" }] };
check("echo off is the original prompt",
      translationPrompt(chunk, {}) === translationPrompt(chunk, {}, null, { echo: false }));
check("echo prompt shows the copy format",
      translationPrompt(chunk, {}, null, { echo: true }).includes('{"1": {"ja": "昔は", "en": "..."}'));

// --- translateUnits: a shifted line is rejected and asked for again
const units = [{ ja: "昔は" }, { ja: "ニュースを見て" }, { ja: "お金持ちが" }];
const calls = [];
const logs = [];
const shifted = async (prompt) => {
  calls.push(prompt);
  if (calls.length === 1) {
    return JSON.stringify({ 1: { ja: "昔は", en: "Back then" },
                            2: { ja: "お金持ちが", en: "rich people" },   // line 3's copy
                            3: { ja: "お金持ちが", en: "rich people" } });
  }
  return JSON.stringify({ 2: { ja: "ニュースを見て", en: "watching the news" } });
};
const out = await translateUnits(units, {}, shifted, { echo: true }, (m) => logs.push(m));
check("shifted line rejected, then fixed on retry",
      JSON.stringify(out.translations) === JSON.stringify(["Back then", "watching the news", "rich people"]),
      JSON.stringify(out.translations));
check("rejection is logged", logs.some((m) => m.includes("rejected 1 line(s)")));
check("only the rejected line is asked for again", calls.length === 2 && calls[1].includes("2\tニュースを見て") && !calls[1].includes("1\t昔は"));

// --- bare strings (no copy) are accepted only as a last resort
let bareCalls = 0;
const bare = async () => { bareCalls++; return JSON.stringify({ 1: "Yes" }); };
const bareOut = await translateUnits([{ ja: "はい" }], {}, bare, { echo: true });
check("bare string accepted only on the last retry", bareOut.translations[0] === "Yes" && bareCalls === 3,
      `calls ${bareCalls}`);

// --- echo off behaves exactly as before
const plainOut = await translateUnits([{ ja: "はい" }], {}, bare, {});
check("echo off accepts plain strings at once", plainOut.translations[0] === "Yes");

console.log(failed ? `\n${failed} failing` : "\nall passing");
process.exit(failed ? 1 : 0);
