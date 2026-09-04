// Test for the in-place glossary rewrite in background.js.
// The replacement rule is duplicated here verbatim; keep the two in step.
// Run: node extension/src/glossary-apply.test.mjs

function applyReplacements(units, replacements) {
  let changed = 0;
  const out = units.map((u) => {
    let en = u.en;
    for (const { from, to } of replacements || []) {
      if (!from || !to || from === to) continue;
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordish = /^\w/.test(from) && /\w$/.test(from);
      const re = new RegExp(wordish ? `\\b${esc}\\b` : esc, "g");
      if (re.test(en)) en = en.replace(re, to);
    }
    if (en !== u.en) changed++;
    return { ...u, en };
  });
  return { out, changed };
}

const cases = [
  {
    name: "renames a mis-romanised name",
    en: "Shiranui Frea is streaming again today.",
    reps: [{ from: "Shiranui Frea", to: "Shiranui Flare" }],
    want: "Shiranui Flare is streaming again today.",
  },
  {
    name: "handles hyphenated and possessive forms",
    en: "Frea said it was Frea's turn, and Frea-chan agreed.",
    reps: [{ from: "Frea", to: "Flare" }],
    want: "Flare said it was Flare's turn, and Flare-chan agreed.",
  },
  {
    name: "does NOT match inside a longer word",
    en: "That was a total freak accident and Freakazoid agreed.",
    reps: [{ from: "Frea", to: "Flare" }],
    want: "That was a total freak accident and Freakazoid agreed.",
  },
  {
    name: "is case sensitive",
    en: "the frea was fine",
    reps: [{ from: "Frea", to: "Flare" }],
    want: "the frea was fine",
  },
  {
    name: "corrects a domain term",
    en: "I don't want to do that on delivery.",
    reps: [{ from: "delivery", to: "stream" }],
    want: "I don't want to do that on stream.",
  },
  {
    name: "leaves unrelated lines alone",
    en: "Nothing relevant here.",
    reps: [{ from: "Frea", to: "Flare" }],
    want: "Nothing relevant here.",
  },
  {
    name: "escapes regex metacharacters in the old value",
    en: "It cost $5 (roughly).",
    reps: [{ from: "$5 (roughly)", to: "five dollars" }],
    want: "It cost five dollars.",
  },
  {
    name: "ignores a no-op replacement",
    en: "Flare is here.",
    reps: [{ from: "Flare", to: "Flare" }],
    want: "Flare is here.",
  },
  {
    name: "applies several replacements to one line",
    en: "Frea talked about delivery for ages.",
    reps: [{ from: "Frea", to: "Flare" }, { from: "delivery", to: "stream" }],
    want: "Flare talked about stream for ages.",
  },
];

let failed = 0;
for (const c of cases) {
  const { out } = applyReplacements([{ en: c.en }], c.reps);
  const got = out[0].en;
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${c.name}`);
  if (!ok) {
    console.log(`        got:  ${got}`);
    console.log(`        want: ${c.want}`);
  }
}

// changed-count must reflect lines touched, not replacements attempted
const { changed } = applyReplacements(
  [{ en: "Frea one" }, { en: "Frea two" }, { en: "nothing" }],
  [{ from: "Frea", to: "Flare" }]
);
const countOk = changed === 2;
if (!countOk) failed++;
console.log(`${countOk ? "ok  " : "FAIL"}  counts changed lines (${changed}, want 2)`);

console.log(failed ? `\n${failed} failing` : "\nall passing");
process.exit(failed ? 1 : 0);
