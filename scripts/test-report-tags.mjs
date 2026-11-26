// scripts/test-report-tags.mjs
//
// Sentence tags: splitting, normal versus abnormal, the CURV draft turned into
// tags and COMMENT, the assembled report and older cases.
//
//   node scripts/test-report-tags.mjs

import assert from "node:assert";
import {
    cleanView,
  reportTitle,
  examinationName,
  splitSentences,
  sentencesOf,
  isNormalSentence,
  makeTag,
  nextTagKey,
  tagsFromText,
  parseReportSections,
  deriveFromReport,
  assembleReport,
  ensureTags,
} from "../shared/reportTags.js";
import { withoutThinking, thinkingBlockOf } from "../shared/reportText.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

console.log("\n=== title and view ===");

test("the report title and examination name follow the view", () => {
  assert.equal(reportTitle("PA"), "XRAY CHEST (PA)");
  assert.equal(reportTitle("AP supine"), "XRAY CHEST (AP SUPINE)");
  assert.equal(reportTitle(""), "XRAY CHEST");
  assert.equal(reportTitle("Lateral"), "XRAY CHEST (LATERAL)");
  assert.equal(examinationName("PA"), "Chest (PA)");
  assert.equal(examinationName("lateral"), "Chest (Lateral)");
  assert.equal(cleanView("pa"), "PA");
  assert.equal(cleanView("LATERAL"), "Lateral");
  assert.equal(cleanView("sideways"), "");
});

console.log("\n=== sentences ===");

test("one line of prose is split into sentences, numbers and abbreviations stay whole", () => {
  assert.deepEqual(splitSentences("The lungs are clear. There is a small effusion."), ["The lungs are clear.", "There is a small effusion."]);
  assert.deepEqual(splitSentences("Cardiothoracic ratio is normal, 10.5 : 27.5."), ["Cardiothoracic ratio is normal, 10.5 : 27.5."]);
  assert.deepEqual(splitSentences("Nodule measures 2.3 cm. Seen by Dr. Smith today."), ["Nodule measures 2.3 cm.", "Seen by Dr. Smith today."]);
});

test("list markers and numbering do not make extra sentences", () => {
  assert.deepEqual(sentencesOf("1. Lungs clear. 2. Heart normal."), ["Lungs clear.", "Heart normal."]);
  assert.deepEqual(sentencesOf("- The heart is normal.\n- The lungs are clear."), ["The heart is normal.", "The lungs are clear."]);
});

test("block labels and boilerplate are not findings", () => {
  const out = sentencesOf("Chest X-Ray Report\n\nLungs:\n   - The lungs are clear.\nHeart:\n   - Heart size is normal.");
  assert.deepEqual(out, ["The lungs are clear.", "Heart size is normal."]);
});

test("a wrapped line stays one sentence, so the denial is not cut off", () => {
  assert.deepEqual(
    sentencesOf("No pleural\neffusion or pneumothorax is present."),
    ["No pleural effusion or pneumothorax is present."]
  );
  assert.deepEqual(
    sentencesOf("The cardiac silhouette is within normal limits and\nunchanged."),
    ["The cardiac silhouette is within normal limits and unchanged."]
  );
  assert.deepEqual(
    sentencesOf("There are atherosclerotic\ncalcifications."),
    ["There are atherosclerotic calcifications."]
  );
  assert.deepEqual(
    sentencesOf("Mild degenerative changes in\nthe thoracic spine."),
    ["Mild degenerative changes in the thoracic spine."]
  );
});

console.log("\n=== normal or abnormal ===");

const NORMAL = [
  "Heart size is normal.",
  "The lungs are clear.",
  "No pleural effusion.",
  "No pleural effusion or pneumothorax.",
  "No pleural effusion or pneumothorax is present.",
  "No focal consolidation.",
  "The cardiomediastinal silhouette is unremarkable.",
  "The trachea is midline.",
  "Cardiothoracic ratio is normal, 10.5 : 27.5.",
  "Pleural effusion has resolved.",
  "The costophrenic angles are sharp.",
  "The lungs are well expanded and clear without focal consolidation.",
  "No acute osseous abnormality.",
  "The hila are unremarkable, without lymphadenopathy.",
];
const ABNORMAL = [
  "Small right pleural effusion.",
  "There is a focal opacity in the right lower zone.",
  "Possible small pneumothorax at the left apex.",
  "Pneumonia cannot be excluded.",
  "The cardiac silhouette is enlarged.",
  "A left-sided pacemaker is in place.",
  "Bibasilar atelectasis.",
  "The lungs are clear but there is a right lower zone opacity.",
  "No change in the right lower lobe opacity.",
  "Hazy opacification of the left base may represent consolidation.",
  "Cardiothoracic ratio is increased, 14.0 : 25.0.",
  "Findings suggest an early infection.",
  "Moderate cardiomegaly.",
];

for (const s of NORMAL) test(`normal: ${s}`, () => assert.equal(isNormalSentence(s), true));
for (const s of ABNORMAL) test(`abnormal: ${s}`, () => assert.equal(isNormalSentence(s), false));

test("a sentence that says nothing either way counts as abnormal, so it can be boxed", () => {
  assert.equal(isNormalSentence("Marked area."), false);
  assert.equal(isNormalSentence("Further review is suggested."), false);
});

console.log("\n=== tags ===");

test("keys count up from the highest key", () => {
  assert.equal(nextTagKey([]), "t1");
  assert.equal(nextTagKey([{ key: "t1" }, { key: "t7" }]), "t8");
});

test("a tag knows whether it is abnormal", () => {
  const tags = tagsFromText("Heart size is normal.\nSmall right pleural effusion.");
  assert.deepEqual(tags.map((t) => [t.key, t.abnormal]), [["t1", false], ["t2", true]]);
  assert.equal(makeTag("Heart size is normal.", tags).key, "t3");
});

console.log("\n=== the CURV draft ===");

const CURV = [
  "Findings:",
  "The lung volumes are low. There is bibasilar atelectasis.",
  "The heart size is normal. No pleural effusion.",
  "",
  "Thinking:",
  "Low volumes favour atelectasis over pneumonia, since there is no fever.",
  "",
  "Impression:",
  "Bibasilar atelectasis.",
].join("\n");

test("a CURV draft becomes one tag per sentence, in order, and the Impression becomes COMMENT", () => {
  const d = deriveFromReport(CURV);
  assert.deepEqual(d.findingTags.map((t) => t.text), [
    "The lung volumes are low.",
    "There is bibasilar atelectasis.",
    "The heart size is normal.",
    "No pleural effusion.",
  ]);
  assert.deepEqual(d.findingTags.map((t) => t.abnormal), [true, true, false, false]);
  assert.equal(d.comment, "Bibasilar atelectasis.");
});

test("Thinking is kept apart and never becomes a sentence", () => {
  const d = deriveFromReport(CURV);
  assert.ok(d.thinking.includes("Low volumes favour atelectasis"));
  assert.ok(!d.findingTags.some((t) => /favour/.test(t.text)));
  assert.ok(!d.comment.includes("favour"));
});

console.log("\n=== the assembled report ===");

test("the layout is title, FINDINGS, one sentence per line, COMMENT", () => {
  const text = assembleReport({
    view: "PA",
    tags: [{ text: "Heart size is normal." }, { text: "Small right pleural effusion." }],
    comment: "Small right pleural effusion.",
  });
  assert.equal(text, [
    "XRAY CHEST (PA)", "", "FINDINGS", "Heart size is normal.", "Small right pleural effusion.", "",
    "COMMENT", "– Small right pleural effusion.",
  ].join("\n"));
  assert.ok(!text.includes("Thank you for your referral."));
});

test("Thinking is carried at the end and stripped from what readers see", () => {
  const d = deriveFromReport(CURV);
  const text = assembleReport({ view: "PA", tags: d.findingTags, comment: d.comment, thinking: d.thinking });
  assert.ok(thinkingBlockOf(text).includes("Low volumes favour"));
  assert.ok(!withoutThinking(text).includes("Low volumes favour"));
  assert.ok(withoutThinking(text).trimEnd().endsWith("– Bibasilar atelectasis."));
  assert.ok(!text.includes("Thank you for your referral."));
});

test("the assembled report reads back into the same tags and COMMENT", () => {
  const d = deriveFromReport(CURV);
  const text = assembleReport({ view: "PA", tags: d.findingTags, comment: d.comment, thinking: d.thinking });
  const back = deriveFromReport(text);
  assert.deepEqual(back.findingTags.map((t) => t.text), d.findingTags.map((t) => t.text));
  assert.equal(back.comment, d.comment);
  assert.equal(parseReportSections(text).thinking, d.thinking);
});

test("COMMENT with several lines gets a dash on each and an empty COMMENT stays empty", () => {
  const text = assembleReport({ tags: [{ text: "Clear." }], comment: "First.\nSecond." });
  assert.ok(text.includes("COMMENT\n– First.\n– Second."));
  assert.equal(assembleReport({ tags: [], comment: "" }).trimEnd().endsWith("COMMENT"), true);
});

console.log("\n=== older cases ===");

test("an older case with only report text is split once, and ensureTags leaves a tagged case alone", () => {
  const old = { reportText: CURV, findings: [], measurements: [] };
  const one = ensureTags(old);
  assert.equal(one.findingTags.length, 4);
  assert.equal(one.tagsDerived, true);
  assert.equal(one.comment, "Bibasilar atelectasis.");
  const again = ensureTags(one);
  assert.equal(again, one, "a case that has tags is returned unchanged");
});

test("an older box is linked to the sentence it belongs to; a normal sentence gets no box", () => {
  const old = {
    reportText: "Findings:\nThe lungs are clear. There is a small right pleural effusion.\n\nImpression:\nSmall right effusion.",
    findings: [
      { label: "Small right pleural effusion", sentence: "There is a small right pleural effusion.", bbox: [60, 60, 20, 15], source: "Azure", bboxSource: "vision", status: "pending" },
      { label: "Clear lungs", sentence: "The lungs are clear.", bbox: [10, 10, 30, 30], source: "Azure", bboxSource: "vision", status: "pending", severity: "normal" },
    ],
  };
  const c = ensureTags(old);
  assert.equal(c.findings[0].tagKey, "t2");
  assert.equal(c.findings[1].tagKey, undefined, "the clear-lungs box had nothing abnormal to link to");
  assert.equal(c.findingTags[0].abnormal, false);
});

test("a box the radiologist drew with no sentence becomes a finding at the end", () => {
  const c = ensureTags({
    reportText: "Findings:\nThe lungs are clear.",
    findings: [{ label: "Marked area", bbox: [1, 2, 3, 4], source: "manual", status: "pending" }],
  });
  assert.deepEqual(c.findingTags.map((t) => t.text), ["The lungs are clear.", "Marked area"]);
  assert.equal(c.findingTags[1].abnormal, true);
  assert.equal(c.findings[0].tagKey, "t2");
});

test("a rejected old box is remembered so Azure does not put it back", () => {
  const c = ensureTags({
    reportText: "Findings:\nThere is a small right pleural effusion.",
    findings: [{ label: "Effusion", sentence: "There is a small right pleural effusion.", bbox: [1, 2, 3, 4], source: "Azure", status: "rejected" }],
  });
  assert.equal(c.findingTags[0].boxDeclined, true);
});

test("a case with no report text is returned as it is", () => {
  const c = { reportText: "", findings: [] };
  assert.equal(ensureTags(c), c);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
