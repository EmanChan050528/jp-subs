// Tests for the .srt/.vtt parser in core/srt.js.
// Run: node extension/src/srt-parse.test.mjs

import { parseSubtitles, describeCues } from "./core/srt.js";

const cases = [
  {
    name: "plain SRT",
    input: [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "こんにちは",
      "",
      "2",
      "00:00:05,000 --> 00:00:06,500",
      "元気ですか",
      "",
    ].join("\n"),
    want: [
      { t_ms: 1000, dur_ms: 3000, ja: "こんにちは" },
      { t_ms: 5000, dur_ms: 1500, ja: "元気ですか" },
    ],
  },
  {
    name: "WebVTT, with header and a dot separator",
    input: [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "はい",
      "",
    ].join("\n"),
    want: [{ t_ms: 1000, dur_ms: 1000, ja: "はい" }],
  },
  {
    name: "WebVTT without an hour field",
    input: "WEBVTT\n\n01:02.500 --> 01:04.000\nそうだね\n",
    want: [{ t_ms: 62500, dur_ms: 1500, ja: "そうだね" }],
  },
  {
    name: "cue settings after the timestamp are ignored",
    input: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:10%\nうん\n",
    want: [{ t_ms: 1000, dur_ms: 1000, ja: "うん" }],
  },
  {
    name: "a one-digit fraction is tenths, not milliseconds",
    input: "1\n00:00:01,5 --> 00:00:02,0\nああ\n",
    want: [{ t_ms: 1500, dur_ms: 500, ja: "ああ" }],
  },
  {
    name: "CRLF and a BOM",
    input: "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nテスト\r\n",
    want: [{ t_ms: 1000, dur_ms: 1000, ja: "テスト" }],
  },
  {
    name: "wrapped Japanese lines rejoin with no space",
    input: "1\n00:00:01,000 --> 00:00:03,000\n今日はとても\n良い天気ですね\n",
    want: [{ t_ms: 1000, dur_ms: 2000, ja: "今日はとても良い天気ですね" }],
  },
  {
    name: "wrapped Latin lines keep their space",
    input: "1\n00:00:01,000 --> 00:00:03,000\nhello\nworld\n",
    want: [{ t_ms: 1000, dur_ms: 2000, ja: "hello world" }],
  },
  {
    name: "markup is stripped, entities survive",
    input:
      "1\n00:00:01,000 --> 00:00:02,000\n<v Flare><i>すごい</i> &amp; まあ</v>\n",
    want: [{ t_ms: 1000, dur_ms: 1000, ja: "すごい & まあ" }],
  },
  {
    name: "escaped angle brackets are not treated as markup",
    input: "1\n00:00:01,000 --> 00:00:02,000\n&lt;笑&gt;\n",
    want: [{ t_ms: 1000, dur_ms: 1000, ja: "<笑>" }],
  },
  {
    name: "ASS positioning overrides are stripped",
    input: "1\n00:00:01,000 --> 00:00:02,000\n{\\an8}上のほう\n",
    want: [{ t_ms: 1000, dur_ms: 1000, ja: "上のほう" }],
  },
  {
    name: "missing blank lines: the index is not dialogue",
    input: [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "いち",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "にい",
    ].join("\n"),
    want: [
      { t_ms: 1000, dur_ms: 1000, ja: "いち" },
      { t_ms: 2000, dur_ms: 1000, ja: "にい" },
    ],
  },
  {
    name: "empty and whitespace-only cues are dropped",
    input: [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "ある",
      "",
    ].join("\n"),
    want: [{ t_ms: 2000, dur_ms: 1000, ja: "ある" }],
  },
  {
    name: "rolling captions: an exact repeat extends the first cue",
    input: [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "おはよう",
      "",
      "00:00:02.000 --> 00:00:05.000",
      "おはよう",
      "",
    ].join("\n"),
    want: [{ t_ms: 1000, dur_ms: 4000, ja: "おはよう" }],
  },
  {
    name: "rolling captions: an overlapping cue keeps only the new tail",
    input: [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "おはよう",
      "",
      "00:00:02.000 --> 00:00:05.000",
      "おはようございます",
      "",
    ].join("\n"),
    want: [
      { t_ms: 1000, dur_ms: 2000, ja: "おはよう" },
      { t_ms: 2000, dur_ms: 3000, ja: "ございます" },
    ],
  },
  {
    name: "genuine repetition is kept when the cues do not overlap",
    input: [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "はい",
      "",
      "2",
      "00:00:10,000 --> 00:00:11,000",
      "はい",
      "",
    ].join("\n"),
    want: [
      { t_ms: 1000, dur_ms: 1000, ja: "はい" },
      { t_ms: 10000, dur_ms: 1000, ja: "はい" },
    ],
  },
  {
    name: "out-of-order cues are sorted",
    input: [
      "1",
      "00:00:09,000 --> 00:00:10,000",
      "あと",
      "",
      "2",
      "00:00:01,000 --> 00:00:02,000",
      "さき",
      "",
    ].join("\n"),
    want: [
      { t_ms: 1000, dur_ms: 1000, ja: "さき" },
      { t_ms: 9000, dur_ms: 1000, ja: "あと" },
    ],
  },
  {
    name: "a file with no timecodes yields nothing",
    input: "this is not a subtitle file at all\njust some prose\n",
    want: [],
  },
];

let failed = 0;

for (const c of cases) {
  const got = parseSubtitles(c.input);
  const gotStr = JSON.stringify(got);
  const wantStr = JSON.stringify(c.want);
  if (gotStr === wantStr) {
    console.log(`  ok   ${c.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${c.name}`);
    console.log(`       want ${wantStr}`);
    console.log(`       got  ${gotStr}`);
  }
}

// describeCues drives the "this file is not Japanese" warning, so its ratio
// matters as much as the parse does.
const ratioCases = [
  { name: "pure Japanese scores 1", cues: [{ ja: "こんにちは", t_ms: 0, dur_ms: 1 }], min: 0.99 },
  { name: "pure English scores 0", cues: [{ ja: "hello there", t_ms: 0, dur_ms: 1 }], max: 0.01 },
];

for (const c of ratioCases) {
  const { cjkRatio } = describeCues(c.cues);
  const ok = (c.min === undefined || cjkRatio >= c.min) && (c.max === undefined || cjkRatio <= c.max);
  if (ok) console.log(`  ok   ${c.name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${c.name} — ratio ${cjkRatio}`);
  }
}

console.log(failed ? `\n${failed} failing` : `\nall ${cases.length + ratioCases.length} passing`);
process.exit(failed ? 1 : 0);
