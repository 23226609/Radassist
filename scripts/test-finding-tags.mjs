// scripts/test-finding-tags.mjs
//
// The edits a radiologist makes to tags, boxes and measurement lines. Each is a
// pure function from one case to the next.
//
//   node scripts/test-finding-tags.mjs

import assert from "node:assert";
import {
  boxesForTag,
  tagOfBox,
  moveTag,
  sameOrder,
  boxOfTag,
  addTag,
  setTagText,
  deleteTag,
  flipTag,
  moveTagTo,
  removeBox,
  placeBox,
  moveBox,
  drawnFinding,
  setCtr,
  refreshCtr,
  addLesionLine,
  removeLine,
} from "../src/lib/findingTags.js";

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

const S1 = "Small right pleural effusion.";
const S2 = "Heart size is normal.";
const S3 = "The lungs are clear.";
const tag = (key, text, abnormal, extra = {}) => ({ key, text, abnormal, manual: false, kind: "", ...extra });
const box = (tagKey, extra = {}) => ({ _id: `b-${tagKey}`, label: "x", bbox: [10, 10, 20, 20], tagKey, source: "Azure", status: "pending", ...extra });

const base = () => ({
  view: "PA",
  findingTags: [tag("t1", S1, true), tag("t2", S2, false), tag("t3", S3, false)],
  findings: [box("t1")],
  measurements: [],
});
const keys = (c) => c.findingTags.map((t) => t.key);

console.log("\n=== order ===");

test("moveTag moves a tag before or after another and leaves the input alone", () => {
  const tags = base().findingTags;
  assert.deepEqual(moveTag(tags, "t3", "t1").map((t) => t.key), ["t3", "t1", "t2"]);
  assert.deepEqual(moveTag(tags, "t1", "t3", true).map((t) => t.key), ["t2", "t3", "t1"]);
  assert.deepEqual(moveTag(tags, "t1", "t1").map((t) => t.key), ["t1", "t2", "t3"]);
  assert.deepEqual(tags.map((t) => t.key), ["t1", "t2", "t3"]);
  assert.equal(sameOrder(tags, moveTag(tags, "t3", "t1")), false);
  assert.equal(sameOrder(tags, [...tags]), true);
});

test("moveTagTo reorders the case without touching boxes", () => {
  const c = moveTagTo(base(), "t3", "t1");
  assert.deepEqual(keys(c), ["t3", "t1", "t2"]);
  assert.equal(c.findings.length, 1);
});

console.log("\n=== words, add and delete ===");

test("a new finding is appended at the end, manual, and classified", () => {
  const { c, tag: added } = addTag(base(), "  Small left apical pneumothorax. ");
  assert.deepEqual(keys(c), ["t1", "t2", "t3", "t4"]);
  assert.equal(added.text, "Small left apical pneumothorax.");
  assert.equal(added.abnormal, true);
  assert.equal(added.manual, true);
  assert.equal(addTag(c, "The trachea is midline.").tag.abnormal, false);
  assert.equal(addTag(c, "   ").tag, null);
});

test("changing a sentence changes the label of its box and nothing else", () => {
  const c = setTagText(base(), "t1", "Moderate right pleural effusion.");
  assert.equal(c.findingTags[0].text, "Moderate right pleural effusion.");
  assert.equal(c.findings[0].label, "Moderate right pleural effusion.");
  assert.equal(c.findings[0].bbox.join(), "10,10,20,20");
});

test("deleting a tag deletes its box and its measurement lines", () => {
  const c = deleteTag({ ...base(), measurements: [{ tagKey: "t1", kind: "lesion" }, { tagKey: "t2", kind: "lesion" }] }, "t1");
  assert.deepEqual(keys(c), ["t2", "t3"]);
  assert.deepEqual(c.findings, []);
  assert.deepEqual(c.measurements.map((m) => m.tagKey), ["t2"]);
});

console.log("\n=== normal or abnormal, one box ===");

test("switching an abnormal tag to normal drops its box", () => {
  const c = flipTag(base(), "t1");
  assert.equal(c.findingTags[0].abnormal, false);
  assert.deepEqual(c.findings, []);
});

test("switching a normal tag to abnormal adds no box by itself", () => {
  const c = flipTag(base(), "t3");
  assert.equal(c.findingTags[2].abnormal, true);
  assert.equal(boxesForTag(c.findings, "t3").length, 0);
});

test("a box is placed for an abnormal tag, and a second box replaces the first", () => {
  let c = placeBox(flipTag(base(), "t3"), "t3", [5, 5, 10, 10]);
  assert.equal(boxesForTag(c.findings, "t3").length, 1);
  c = placeBox(c, "t3", [30, 30, 10, 10]);
  assert.equal(boxesForTag(c.findings, "t3").length, 1);
  assert.deepEqual(boxOfTag(c, "t3").bbox, [30, 30, 10, 10]);
  assert.equal(boxOfTag(c, "t3").source, "manual");
  assert.equal(tagOfBox(c.findingTags, boxOfTag(c, "t3")).key, "t3");
});

test("moving a box marks it as the radiologist's", () => {
  const c = moveBox(base(), "t1", [40, 40, 10, 10]);
  assert.deepEqual(boxOfTag(c, "t1").bbox, [40, 40, 10, 10]);
  assert.equal(boxOfTag(c, "t1").bboxSource, "manual");
});

test("removing a box keeps the tag and records that Azure must not put it back", () => {
  const c = removeBox(base(), "t1");
  assert.equal(c.findingTags[0].boxDeclined, true);
  assert.equal(c.findingTags[0].abnormal, true);
  assert.equal(boxesForTag(c.findings, "t1").length, 0);
  assert.equal(c.findings[0].status, "rejected", "the Azure box stays as a rejected record");
  const drawn = removeBox(placeBox(flipTag(base(), "t3"), "t3", [1, 1, 5, 5]), "t3");
  assert.equal(drawn.findings.some((f) => f.tagKey === "t3"), false, "a hand-drawn box is simply deleted");
});

test("a box drawn with no tag chosen starts a new abnormal finding at the end", () => {
  const { c, tag: added } = drawnFinding(base(), [20, 20, 10, 10]);
  assert.equal(added.key, "t4");
  assert.equal(added.abnormal, true);
  assert.equal(keys(c).at(-1), "t4");
  assert.equal(boxesForTag(c.findings, "t4").length, 1);
});

console.log("\n=== heart size ===");

const spaced = (mm, px = mm * 10) => ({ x1: 0, y1: 0, x2: 0, y2: 0, lengthMm: mm, lengthPx: px, spacingTag: "ImagerPixelSpacing", text: "" });
const heartLine = (mm) => ({ ...spaced(mm), x1: 30, y1: 55, x2: 70, y2: 55 });
const thoraxLine = (mm) => ({ ...spaced(mm), x1: 10, y1: 40, x2: 90, y2: 40 });

test("a normal ratio on a PA film is a sentence with no box, appended at the end", () => {
  const { c, key } = setCtr(base(), heartLine(105), thoraxLine(275));
  const t = c.findingTags.find((x) => x.key === key);
  assert.equal(key, "t4");
  assert.equal(t.text, "Cardiothoracic ratio is normal, 10.5 : 27.5.");
  assert.equal(t.kind, "ctr");
  assert.equal(t.abnormal, false);
  assert.equal(boxesForTag(c.findings, key).length, 0);
  assert.deepEqual(c.measurements.map((m) => m.kind), ["ctr-heart", "ctr-thorax"]);
  assert.ok(c.measurements.every((m) => m.tagKey === key));
});

test("an increased ratio gets exactly one box on the heart line", () => {
  const { c, key } = setCtr(base(), heartLine(140), thoraxLine(250));
  const t = c.findingTags.find((x) => x.key === key);
  assert.equal(t.text, "Cardiothoracic ratio is increased, 14.0 : 25.0.");
  assert.equal(t.abnormal, true);
  assert.equal(boxesForTag(c.findings, key).length, 1);
});

test("drawing the ratio again replaces the old lines and sentence, not adds a second", () => {
  const first = setCtr(base(), heartLine(140), thoraxLine(250));
  const second = setCtr(first.c, heartLine(105), thoraxLine(275));
  assert.equal(second.key, first.key);
  assert.equal(second.c.findingTags.filter((t) => t.kind === "ctr").length, 1);
  assert.equal(second.c.measurements.length, 2);
  assert.equal(boxesForTag(second.c.findings, second.key).length, 0, "now normal, so no box");
});

test("another view words the ratio again, with no normal or increased and no box", () => {
  const { c, key } = setCtr(base(), heartLine(140), thoraxLine(250));
  const ap = refreshCtr({ ...c, view: "AP" });
  const t = ap.findingTags.find((x) => x.key === key);
  assert.ok(t.text.includes("14.0 : 25.0") && t.text.includes("not applied"));
  assert.equal(t.abnormal, false);
  assert.equal(boxesForTag(ap.findings, key).length, 0);
  const back = refreshCtr({ ...ap, view: "PA" });
  assert.ok(back.findingTags.find((x) => x.key === key).text.startsWith("Cardiothoracic ratio is increased"));
  assert.equal(boxesForTag(back.findings, key).length, 1);
});

test("taking away one diameter takes away the ratio sentence", () => {
  const { c, key } = setCtr(base(), heartLine(140), thoraxLine(250));
  const out = removeLine(c, c.measurements[0]);
  assert.equal(out.findingTags.some((t) => t.key === key), false);
  assert.equal(out.measurements.length, 0);
  assert.equal(out.findings.some((f) => f.tagKey === key), false);
});

console.log("\n=== a lesion line ===");

const lesion = (mm) => ({ x1: 10, y1: 10, x2: 40, y2: 50, kind: "lesion", lengthPx: mm * 10, lengthMm: mm, text: `${(mm / 10).toFixed(2)} cm film size, not body size`, spacingTag: "ImagerPixelSpacing" });

test("with an abnormal sentence selected the measurement is written into it", () => {
  const { c, key } = addLesionLine(base(), lesion(50), "t1");
  assert.equal(key, "t1");
  assert.equal(c.findingTags[0].text, "Small right pleural effusion, measuring Film 5.00 cm · Body size unavailable.");
  assert.equal(c.measurements.length, 1);
  assert.equal(c.measurements[0].tagKey, "t1");
  assert.equal(boxesForTag(c.findings, "t1").length, 1, "still one box");
});

test("measuring again replaces the clause instead of stacking another", () => {
  const once = addLesionLine(base(), lesion(50), "t1").c;
  const twice = addLesionLine(once, lesion(30), "t1").c;
  assert.equal(twice.findingTags[0].text, "Small right pleural effusion, measuring Film 3.00 cm · Body size unavailable.");
  assert.equal(twice.measurements.length, 1);
});

test("with nothing selected the line starts a new abnormal finding with one box", () => {
  const { c, key } = addLesionLine(base(), lesion(50), "");
  assert.equal(key, "t4");
  assert.ok(c.findingTags[3].text.includes("measuring Film 5.00 cm · Body size unavailable"));
  assert.equal(c.findingTags[3].abnormal, true);
  assert.equal(boxesForTag(c.findings, "t4").length, 1);
});

test("a normal sentence selected does not take a measurement: a new finding is made", () => {
  const { c, key } = addLesionLine(base(), lesion(50), "t2");
  assert.equal(key, "t4");
  assert.equal(c.findingTags[1].text, S2);
});

test("with no spacing the clause is in pixels and has no centimetres", () => {
  const line = { x1: 10, y1: 10, x2: 40, y2: 50, kind: "lesion", lengthPx: 500, lengthMm: null, text: "500 px", spacingTag: "" };
  const { c } = addLesionLine(base(), line, "t1");
  assert.equal(c.findingTags[0].text, "Small right pleural effusion, measuring 500 px.");
});

test("deleting the line takes the words out of the sentence", () => {
  const { c } = addLesionLine(base(), lesion(50), "t1");
  const out = removeLine(c, c.measurements[0]);
  assert.equal(out.findingTags[0].text, "Small right pleural effusion.");
  assert.equal(out.measurements.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
