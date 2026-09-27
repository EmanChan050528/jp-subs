// Source-language registry and track selection.
// Run: node extension/src/languages.test.mjs

import { pickSource, canTranslate, labelOf, SOURCE_PRIORITY } from "./core/languages.js";

let failed = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}\n       want ${w}\n       got  ${g}`); }
};

console.log("\n--- track selection ---");

check("picks Japanese when present",
  pickSource([{ lang: "en", kind: "asr" }, { lang: "ja", kind: "asr" }])?.lang, "ja");

check("picks Korean when there is no Japanese",
  pickSource([{ lang: "en", kind: "asr" }, { lang: "ko", kind: "asr" }])?.lang, "ko");

// A video carrying both should translate rather than stop, so Japanese wins.
check("prefers Japanese over Korean when both exist",
  pickSource([{ lang: "ko", kind: "asr" }, { lang: "ja", kind: "asr" }])?.lang, "ja");

check("returns null when neither is present",
  pickSource([{ lang: "en", kind: "asr" }, { lang: "es", kind: "asr" }]), null);

check("returns null for an empty track list", pickSource([]), null);

check("accepts YouTube's own languageCode key",
  pickSource([{ languageCode: "ko", kind: "asr" }])?.lang, "ko");

check("keeps the track's kind", pickSource([{ lang: "ja", kind: "asr" }])?.kind, "asr");

console.log("\n--- capability ---");

// The distinction the whole step rests on: Korean can be extracted but not
// translated, because extraction is language-agnostic and prompts are not.
check("Japanese is translatable", canTranslate("ja"), true);
check("Korean is not translatable yet", canTranslate("ko"), false);
check("an unknown language is not translatable", canTranslate("en"), false);
check("undefined is not translatable", canTranslate(undefined), false);

console.log("\n--- labels ---");
check("Japanese label", labelOf("ja"), "Japanese");
check("Korean label", labelOf("ko"), "Korean");
check("unknown code falls back to itself", labelOf("de"), "de");
check("missing code does not throw", labelOf(undefined), "unknown");

console.log("\n--- priority list matches the interceptor's inline copy ---");
// interceptor.js cannot import this module (MAIN-world content scripts are
// classic scripts), so it holds a duplicate. If this assertion is edited,
// edit SOURCE_PRIORITY in interceptor.js in the same commit.
check("priority order", SOURCE_PRIORITY, ["ja", "ko"]);

console.log(failed ? `\n${failed} failing` : `\nall passing`);
process.exit(failed ? 1 : 0);
