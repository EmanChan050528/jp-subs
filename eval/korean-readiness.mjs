// Korean readiness probe — run BEFORE committing to Korean support.
// Run: node eval/korean-readiness.mjs
//
// This answers one half of the Korean question: does the existing code
// mechanically handle Korean at all? Every check here is about character
// classes and punctuation, which is decidable without knowing Korean, so the
// findings hold regardless of how good the sample sentences are.
//
// It does NOT answer the half that decides whether Korean is worth doing:
// whether YouTube's Korean->English auto-translation is as weak as its
// Japanese->English. That needs a real Korean caption track plus YouTube's own
// English for the same window — the fixture pair that exists for Japanese in
// fixtures/ — and a Korean reader to score it. See eval/README.md.

import { segment, stats } from "../extension/src/core/segment.js";
import { describeCues } from "../extension/src/core/srt.js";

const line = (s) => console.log(s);
const head = (s) => console.log(`\n=== ${s} ===`);

// ---------------------------------------------------------- 1. punctuation

head("1. Sentence-end detection");

// The exact regex from segment.js, copied so this probe reports on the real
// rule rather than a paraphrase of it.
const SENTENCE_END = /[。．！？!?]+["'」』）\)】〉》]*\s*$/;

const samples = [
  ["JA  full stop", "今日も配信を始めます。"],
  ["JA  question", "元気ですか？"],
  ["KO  full stop", "오늘도 방송 시작합니다."],
  ["KO  question", "재밌지 않아요?"],
  ["KO  exclamation", "진짜 재밌네요!"],
  ["KO  no punctuation", "저는 별로 안 좋아해요"],
];

for (const [label, text] of samples) {
  line(`  ${label.padEnd(20)} endsSentence=${SENTENCE_END.test(text)}`);
}

line("");
line("  The class is [。．！？!?]: it carries the FULLWIDTH period ．(U+FF0E)");
line("  but not the ASCII '.', which is the one Korean uses. Korean statements");
line("  therefore never close a unit; only questions and exclamations do.");

// -------------------------------------------------------- 2. segmentation

head("2. Segmentation, on the real segment()");

// Shaped like an ASR track: no `segs`, so the fallback timing path runs.
const jaCues = [
  { t_ms: 0, dur_ms: 3000, ja: "どうも皆さんこんばんは。お待たせいたしました。" },
  { t_ms: 3000, dur_ms: 3000, ja: "今日はスターデューバレーをやります。" },
  { t_ms: 6000, dur_ms: 3000, ja: "昨日は農場を拡張しました。楽しかったです。" },
  { t_ms: 9000, dur_ms: 3000, ja: "大会は対人系はあんまり参加しないので。" },
];

const koCues = [
  { t_ms: 0, dur_ms: 3000, ja: "안녕하세요 여러분. 오래 기다리셨습니다." },
  { t_ms: 3000, dur_ms: 3000, ja: "오늘은 스타듀밸리를 할 거예요." },
  { t_ms: 6000, dur_ms: 3000, ja: "어제는 농장을 확장했어요. 재밌었어요." },
  { t_ms: 9000, dur_ms: 3000, ja: "대회는 대인전은 별로 참가 안 해요." },
];

for (const [label, cues] of [["Japanese", jaCues], ["Korean", koCues]]) {
  const units = segment(cues);
  const s = stats(cues, units);
  line(`\n  ${label}: ${cues.length} cues -> ${units.length} units`);
  line(`    units ending in punctuation: ${s.unitsEndingInPunctuation}/${units.length}`);
  line(`    unit chars mean/max:         ${s.unitCharsMean} / ${s.unitCharsMax}`);
  for (const u of units) {
    line(`      ${String(u.start_ms).padStart(5)}-${String(u.end_ms).padStart(5)}  ${JSON.stringify(u.ja)}`);
  }
}

line("");
line("  Two separate defects show up in the Korean output:");
line("   - units run past sentence boundaries, because '.' does not close one;");
line("   - cues are concatenated with no separator ('...습니다.오늘은'), which is");
line("     right for Japanese and wrong for a language written with spaces.");

// -------------------------------------------------- 3. language detection

head("3. Language detection in srt.js");

const jaFile = [{ t_ms: 0, dur_ms: 1000, ja: "こんにちは皆さん" }];
const koFile = [{ t_ms: 0, dur_ms: 1000, ja: "안녕하세요 여러분" }];

line(`  Japanese file cjkRatio: ${describeCues(jaFile).cjkRatio.toFixed(2)}`);
line(`  Korean   file cjkRatio: ${describeCues(koFile).cjkRatio.toFixed(2)}`);
line("");
line("  Hangul is U+AC00-U+D7AF, outside every range the CJK class covers, so a");
line("  Korean file scores 0. The subtitle-file page warns below 0.20 and tells");
line("  the reader their file is the wrong language. Correct for a Japanese-only");
line("  tool; a hard blocker the moment Korean is supported.");

// ------------------------------------------------------------- 4. density

head("4. Character density (maxChars is tuned to 64 for Japanese)");

const pairs = [
  ["JA", "大会は対人系はあんまり参加しないので"],
  ["KO", "대회는 대인전은 별로 참가 안 해요"],
];
for (const [label, text] of pairs) {
  const spaces = (text.match(/ /g) || []).length;
  line(`  ${label}  ${String(text.length).padStart(3)} chars, ${spaces} spaces  ${JSON.stringify(text)}`);
}
line("");
line("  Roughly the same sentence costs about the same number of characters, but");
line("  a quarter of the Korean ones are spaces. The 64-char unit cap therefore");
line("  buys less content in Korean and would need re-tuning, not reuse.");
