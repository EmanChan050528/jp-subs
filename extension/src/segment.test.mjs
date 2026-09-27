// Segmentation tests, with the Japanese fixtures as a regression guard.
// Run: node extension/src/segment.test.mjs
//
// The Japanese counts at the bottom are the point of this file. Every change
// made for Korean is a change to code Japanese runs through, and "it still
// works" is not something to establish by eye.

import { readFileSync } from "node:fs";
import { segment } from "./core/segment.js";
import { parseSubtitles } from "./core/srt.js";
import { joiner, detectScript } from "./core/script.js";

let failed = 0;

function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}\n       want ${w}\n       got  ${g}`);
  }
}

const cue = (t_ms, dur_ms, ja) => ({ t_ms, dur_ms, ja });
const texts = (cues) => segment(cues).map((u) => u.ja);

console.log("\n--- sentence ends ---");

check(
  "ASCII period closes a unit (Korean)",
  texts([cue(0, 4000, "안녕하세요 여러분. 오늘은 방송을 합니다.")]),
  ["안녕하세요 여러분.", "오늘은 방송을 합니다."]
);

check(
  "ideographic period still closes a unit (Japanese)",
  texts([cue(0, 4000, "こんばんは。今日も配信します。")]),
  ["こんばんは。", "今日も配信します。"]
);

check(
  "a decimal is not a sentence end",
  texts([cue(0, 3000, "가격은 3.5배 올랐어요.")]),
  ["가격은 3.5배 올랐어요."]
);

console.log("\n--- joining across cues ---");

check(
  "Korean cues join with a space",
  texts([cue(0, 1000, "오늘은"), cue(1000, 1000, "방송을 합니다.")]),
  ["오늘은 방송을 합니다."]
);

check(
  "Japanese cues join with nothing",
  texts([cue(0, 1000, "こんにちは"), cue(1000, 1000, "皆さん。")]),
  ["こんにちは皆さん。"]
);

check("joiner: Japanese boundary is empty", joiner("こんにちは", "皆さん"), "");
check("joiner: Korean boundary is a space", joiner("오늘은", "방송"), " ");
check("joiner: Latin boundary is a space", joiner("hello", "world"), " ");
check("joiner: existing whitespace is not doubled", joiner("hello ", "world"), "");

// Japanese embeds ASCII with no spaces. Requiring both sides to be kana or
// Han before joining tightly put a space inside all of these — nine units
// across the two fixtures — while unit COUNTS stayed identical and hid it.
check("joiner: kana then ASCII digit stays tight", joiner("もう", "1回"), "");
check("joiner: kana then Latin stays tight", joiner("やりすぎたら", "Aチーム"), "");
check("joiner: Latin then kana stays tight", joiner("YouTube", "で動画"), "");
check("joiner: CJK punctuation then digit stays tight", joiner("あの、", "3日"), "");

check(
  "Japanese keeps inline ASCII tight across a cue boundary",
  texts([cue(0, 1000, "もう"), cue(1000, 1000, "1回勝負よ。")]),
  ["もう1回勝負よ。"]
);

console.log("\n--- speaker turns ---");

check(
  "the >> marker is stripped from the text",
  texts([cue(0, 2000, ">> 안녕하세요.")]),
  ["안녕하세요."]
);

check(
  "a speaker change forces a unit boundary mid-sentence",
  texts([cue(0, 1000, "그래서 내가"), cue(1000, 1000, ">> 아니야")]),
  ["그래서 내가", "아니야"]
);

check(
  "units record which ones begin a turn",
  segment([cue(0, 1000, "그래서 내가"), cue(1000, 1000, ">> 아니야")]).map((u) => !!u.turn),
  [false, true]
);

check(
  "an HTML-escaped marker is handled too",
  texts([cue(0, 2000, "&gt;&gt; 안녕하세요.")]),
  ["안녕하세요."]
);

check(
  "Japanese is unaffected by turn handling",
  segment([cue(0, 2000, "こんばんは。")]).map((u) => !!u.turn),
  [false]
);

console.log("\n--- script detection ---");

check("Japanese", detectScript("こんにちは皆さん").script, "japanese");
check("Korean", detectScript("안녕하세요 여러분").script, "korean");
check("English", detectScript("hello there").script, "other");

console.log("\n--- regression: the Japanese fixtures must not move ---");

const fixtures = [
  ["EmteTL5Ij8g_30-40min.ja.json", 131, 78],
  ["NSY6YHXbxtA_full.ja.json", 202, 235],
];

for (const [file, wantCues, wantUnits] of fixtures) {
  const cues = JSON.parse(readFileSync(`eval/fixtures/${file}`, "utf8")).cues;
  const units = segment(cues);
  check(`${file}: ${wantCues} cues -> ${wantUnits} units`,
    [cues.length, units.length], [wantCues, wantUnits]);

  // Counts are not enough. The spacing bug above left every count identical
  // and still changed the text, so assert on content: these tracks contain no
  // spaces, and the segmenter must not introduce any.
  const withSpaces = units.filter((u) => /\s/.test(u.ja));
  check(`${file}: no spaces introduced into Japanese units`,
    withSpaces.length, 0);
}

console.log("\n--- Korean with word-level timings (the live YouTube path) ---");

// The .srt fixture has no `segs`, so it only ever exercised the fallback
// timing path. About 40% of the live track's events DO carry segs and go
// through charTimes() instead — a branch Korean had never run through until
// a user reported the output looking wrong and it had to be ruled out.
const segsFixture = JSON.parse(
  readFileSync("eval/fixtures/k9QHpWEX2WA_30-30.5min.ko-segs.json", "utf8")
);
const segUnits = segment(segsFixture.cues);

// Segmentation may re-cut and re-space, but it must never lose or invent a
// character. Compare with spacing and markers removed.
const bare = (s) => s.replace(/(?:>>|&gt;&gt;)/g, "").replace(/\s+/g, "");
check("the timed path loses no text",
  bare(segUnits.map((u) => u.ja).join("")),
  bare(segsFixture.cues.map((c) => c.ja).join("")));

check("no >> survives into a unit",
  segUnits.some((u) => u.ja.includes(">>")), false);
// Five cues in the fixture open with a marker; each must yield exactly one
// turn-marked unit.
check("speaker turns are found on the timed path",
  segUnits.filter((u) => u.turn).length,
  segsFixture.cues.filter((c) => /^\s*(?:>>|&gt;&gt;)/.test(c.ja)).length);
check("no unit starts or ends with whitespace",
  segUnits.some((u) => u.ja !== u.ja.trim()), false);
check("no unit is empty", segUnits.some((u) => !u.ja), false);

console.log("\n--- Korean fixture: the numbers the fixes were made for ---");

const ko = parseSubtitles(readFileSync("eval/fixtures/k9QHpWEX2WA_full.ko.srt", "utf8"));
const koUnits = segment(ko);
const koDur = koUnits.map((u) => u.end_ms - u.start_ms).sort((a, b) => a - b);
const over12 = koDur.filter((d) => d > 12000).length;
const median = koDur[koDur.length >> 1];

// Before the fixes: 1,238 units, 9.0 s median, 207 over twelve seconds.
check("median unit is under 6s on screen", median < 6000, true);
check("fewer than 40 units exceed 12s", over12 < 40, true);
check("speaker turns are detected", koUnits.filter((u) => u.turn).length > 1000, true);
check("no unit still carries a >> marker", koUnits.some((u) => u.ja.includes(">>")), false);

console.log(
  `\n  (Korean: ${ko.length} cues -> ${koUnits.length} units, ` +
  `median ${(median / 1000).toFixed(1)}s, ${over12} over 12s)`
);

console.log(failed ? `\n${failed} failing` : `\nall passing`);
process.exit(failed ? 1 : 0);
