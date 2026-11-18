// scripts/test-measure.mjs
//
// Measurements on the film: which spacing tag gives the centimetres, the
// film-size wording, the cardiothoracic ratio and its sentence.
//
//   node scripts/test-measure.mjs

import assert from "node:assert";
import {
  CTR_PA_LIMIT,
  LIMITATION,
  spacingOf,
  lineGeometry,
  filmMm,
  lineText,
  buildLine,
  magnificationOf,
  getMeasurementPolicy,
  experimentalLabel,
  ctrRatio,
  ctrSentence,
  boxAroundLine,
  describeMeasurement,
  applyMagnification,
} from "../src/lib/measure.js";

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

console.log("\n=== which spacing is used ===");

test("Imager Pixel Spacing wins when the file has both tags", () => {
  const s = spacingOf({ imagerPixelSpacingMm: [0.14, 0.14], dicomPixelSpacingMm: [0.2, 0.2], pixelSpacingMm: [0.14, 0.14] });
  assert.deepEqual(s.mm, [0.14, 0.14]);
  assert.equal(s.source, "ImagerPixelSpacing");
  assert.ok(s.name.includes("(0018,1164)"));
});

test("with only Pixel Spacing the number is used and the tag is named", () => {
  const s = spacingOf({ pixelSpacingMm: [0.2, 0.2], dicomPixelSpacingMm: [0.2, 0.2], pixelSpacingSource: "PixelSpacing" });
  assert.deepEqual(s.mm, [0.2, 0.2]);
  assert.equal(s.source, "PixelSpacing");
  assert.ok(s.name.includes("(0028,0030)"));
});

test("with no spacing there is no number and no tag", () => {
  const s = spacingOf({});
  assert.equal(s.mm, null);
  assert.equal(s.source, "");
  assert.equal(spacingOf({ pixelSpacingMm: [0, 0] }).mm, null);
});

test("a smaller copy of the film on screen scales the spacing", () => {
  const s = spacingOf({ imagerPixelSpacingMm: [0.1, 0.2] }, { row: 2, col: 3 });
  assert.deepEqual(s.mm.map((n) => Math.round(n * 100) / 100), [0.2, 0.6]);
});

console.log("\n=== body size, from the file's own geometry ===");

test("Pixel Spacing smaller than Imager Pixel Spacing is the patient-plane size", () => {
  const mag = magnificationOf({ imagerPixelSpacingMm: [0.14, 0.14], dicomPixelSpacingMm: [0.12, 0.12] });
  assert.equal(mag.source, "PixelSpacing");
  assert.equal(mag.factor.toFixed(2), (0.14 / 0.12).toFixed(2));
});

test("the same spacing twice is not a calibration, and a guessed tube distance is not used", () => {
  assert.equal(magnificationOf({ imagerPixelSpacingMm: [0.14, 0.14], dicomPixelSpacingMm: [0.14, 0.14] }), null);
  assert.equal(magnificationOf({ imagerPixelSpacingMm: [0.14, 0.14] }), null);
  assert.equal(magnificationOf({ pixelSpacingMm: [0.14, 0.14], dicomPixelSpacingMm: [0.14, 0.14] }), null);
});

test("a stored magnification factor is used when the two spacings do not differ", () => {
  const mag = magnificationOf({ imagerPixelSpacingMm: [0.14, 0.14], dicomPixelSpacingMm: [0.14, 0.14], estimatedMagnification: 1.12 });
  assert.equal(mag.source, "EstimatedRadiographicMagnificationFactor");
  assert.equal(mag.factor, 1.12);
});

test("source distance and body thickness give a mid-chest estimate", () => {
  const mag = magnificationOf({ distanceSourceToDetectorMm: 1800, bodyPartThicknessMm: 250, distanceSourceToPatientMm: 1750 });
  assert.equal(mag.source, "MidPlane");
  // Half of 250 mm, plus the 50 mm grid gap, in front of a 1800 mm detector.
  assert.equal(mag.factor.toFixed(3), (1800 / (1800 - 125 - 50)).toFixed(3));
});

test("source distances alone are the plane against the detector", () => {
  const mag = magnificationOf({ distanceSourceToDetectorMm: 1800, distanceSourceToPatientMm: 1700 });
  assert.equal(mag.source, "SupportPlane");
  assert.equal(mag.factor.toFixed(3), (1800 / 1700).toFixed(3));
});

test("an impossible factor is ignored", () => {
  assert.equal(magnificationOf({ estimatedMagnification: 4 }), null);
  assert.equal(magnificationOf({ distanceSourceToDetectorMm: 1800, distanceSourceToPatientMm: 400 }), null);
});

test("an erect PA film with no geometry is not treated as a calibration", () => {
  assert.equal(magnificationOf({ view: "PA", imagerPixelSpacingMm: [0.143, 0.143] }), null);
  const policy = getMeasurementPolicy({ view: "PA", imagerPixelSpacingMm: [0.143, 0.143] });
  assert.equal(policy.showBodyMeasurement, false);
  assert.equal(policy.showExperimentalEstimate, true);
  assert.equal(policy.classifyCtr, true);
  assert.equal(getMeasurementPolicy({ view: "AP" }).showExperimentalEstimate, false);
  assert.equal(getMeasurementPolicy({ view: "AP supine" }).classifyCtr, false);
  assert.equal(getMeasurementPolicy({ view: "Lateral" }).classifyCtr, false);
  assert.equal(getMeasurementPolicy({ view: "Lateral" }).showExperimentalEstimate, false);
  assert.equal(getMeasurementPolicy({ view: "Lateral", dicomViewPosition: "LATERAL" }).conflict, false);
  assert.equal(getMeasurementPolicy({ view: "" }).reason, "Projection and calibration information were not recorded.");
  const recorded = magnificationOf({ view: "PA", distanceSourceToDetectorMm: 1800, distanceSourceToPatientMm: 1700 });
  assert.equal(recorded.source, "SupportPlane");
  assert.equal(getMeasurementPolicy({ view: "PA", distanceSourceToDetectorMm: 1800, distanceSourceToPatientMm: 1700 }).showBodyMeasurement, true);
});

test("a portable or supine marker disables the estimate when the view is set to PA erect", () => {
  const policy = getMeasurementPolicy({ view: "PA", dicomViewPosition: "AP", patientPosition: "HFS", projectionCues: "PORTABLE SUPINE" });
  assert.equal(policy.conflict, true);
  assert.equal(policy.showBodyMeasurement, false);
  assert.equal(policy.showExperimentalEstimate, false);
  assert.equal(policy.classifyCtr, false);
  assert.ok(policy.reason.includes("PORTABLE"));
  assert.ok(policy.reason.includes("disabled"));
});

test("a made-up 15.29 cm film line is an experimental 14.36 cm, not a calibrated body size", () => {
  const line = applyMagnification({ kind: "lesion", lengthPx: 1069, lengthMm: 152.9, dxPx: 1069, dyPx: 0 }, null);
  assert.equal(line.text, "Film 15.29 cm · Body size unavailable");
  assert.equal(line.bodyLengthMm, null);
  assert.equal(experimentalLabel({ kind: "lesion", lengthMm: 152.9 }), "Experimental estimate: 14.36 cm");
  const said = ctrSentence(
    { kind: "ctr-heart", lengthMm: 152.9, lengthPx: 1069 },
    { kind: "ctr-thorax", lengthMm: 290, lengthPx: 2028 },
    "AP supine"
  );
  assert.equal(ctrRatio({ lengthMm: 152.9 }, { lengthMm: 290 }).toFixed(2), (152.9 / 290).toFixed(2));
  assert.ok(said.text.includes("0.53"));
  assert.ok(said.text.includes("AP supine"));
  assert.ok(said.text.includes("not applied automatically"));
  assert.equal(said.abnormal, false);
});

test("a line shows the body size, the magnification and the film size", () => {
  const mag = magnificationOf({ imagerPixelSpacingMm: [0.1, 0.1], dicomPixelSpacingMm: [0.08, 0.08] });
  const line = buildLine(
    { x1: 0, y1: 0, x2: 50, y2: 0 },
    { width: 1000, height: 1000, spacing: spacingOf({ imagerPixelSpacingMm: [0.1, 0.1] }), magnification: mag }
  );
  assert.equal(line.lengthMm, 50);
  assert.equal(line.bodyLengthMm, 40);
  assert.equal(line.magnification, 1.25);
  assert.equal(line.text, "4.00 cm body · ×1.25 · film 5.00 cm");
});

test("the cardiothoracic ratio is unchanged when both diameters are corrected", () => {
  const heart = { kind: "ctr-heart", lengthMm: 150, lengthPx: 1500, bodyLengthMm: 125, magnification: 1.2 };
  const thorax = { kind: "ctr-thorax", lengthMm: 300, lengthPx: 3000, bodyLengthMm: 250, magnification: 1.2 };
  assert.equal(ctrRatio(heart, thorax).toFixed(2), "0.50");
  const said = ctrSentence(heart, thorax, "PA");
  assert.equal(said.text, "Cardiothoracic ratio is normal, 12.5 : 25.0.");
  assert.equal(said.abnormal, false);
});

console.log("\n=== lines ===");

test("a line is measured in film pixels from its end points in percent", () => {
  const g = lineGeometry({ x1: 10, y1: 10, x2: 40, y2: 50 }, 1000, 1000);
  assert.equal(g.dxPx, 300);
  assert.equal(g.dyPx, 400);
  assert.equal(g.lengthPx, 500);
});

test("film millimetres use the row and column spacing separately", () => {
  const g = { dxPx: 300, dyPx: 400, lengthPx: 500 };
  assert.equal(filmMm(g, { mm: [0.1, 0.1] }), 50);
  assert.equal(Math.round(filmMm(g, { mm: [0.2, 0.1] }) * 100) / 100, Math.round(Math.hypot(30, 80) * 100) / 100);
  assert.equal(filmMm(g, { mm: null }), null);
});

test("centimetres without a calibration say the film size and that body size is unavailable", () => {
  assert.equal(lineText({ kind: "lesion", lengthPx: 500, lengthMm: 50 }), "Film 5.00 cm · Body size unavailable");
  assert.equal(lineText({ kind: "ctr-heart", lengthPx: 400, lengthMm: 105 }), "Heart 10.5 cm film · Body size unavailable");
  assert.equal(lineText({ kind: "ctr-thorax", lengthPx: 800, lengthMm: 275 }), "Thorax 27.5 cm film · Body size unavailable");
});

test("with no spacing the text is pixels only and has no centimetres", () => {
  assert.equal(lineText({ kind: "lesion", lengthPx: 245.4, lengthMm: null }), "245 px");
  assert.equal(lineText({ kind: "ctr-heart", lengthPx: 245.4, lengthMm: null }), "Heart 245 px");
  const line = buildLine({ x1: 0, y1: 0, x2: 10, y2: 0 }, { width: 1000, height: 1000, spacing: { mm: null, source: "" } });
  assert.equal(line.lengthMm, null);
  assert.equal(line.spacingTag, "");
  assert.ok(!/cm/.test(line.text));
});

test("a built line records the spacing tag that supplied the number", () => {
  const spacing = spacingOf({ imagerPixelSpacingMm: [0.1, 0.1] });
  const line = buildLine({ x1: 10, y1: 10, x2: 40, y2: 50 }, { width: 1000, height: 1000, spacing, kind: "lesion", tagKey: "t2" });
  assert.equal(line.lengthPx, 500);
  assert.equal(line.lengthMm, 50);
  assert.equal(line.spacingTag, "ImagerPixelSpacing");
  assert.equal(line.tagKey, "t2");
});

console.log("\n=== cardiothoracic ratio ===");

const heart = (mm, px = mm * 10) => ({ kind: "ctr-heart", lengthMm: mm, lengthPx: px });
const thorax = (mm, px = mm * 10) => ({ kind: "ctr-thorax", lengthMm: mm, lengthPx: px });

test("the ratio is the heart diameter over the thoracic diameter", () => {
  assert.equal(ctrRatio(heart(105), thorax(275)).toFixed(4), (105 / 275).toFixed(4));
  assert.equal(ctrRatio(null, thorax(275)), null);
});

test("the ratio does not depend on which spacing tag gave the centimetres", () => {
  const a = ctrRatio({ lengthPx: 400, lengthMm: 400 * 0.14 }, { lengthPx: 800, lengthMm: 800 * 0.14 });
  const b = ctrRatio({ lengthPx: 400, lengthMm: 400 * 0.2 }, { lengthPx: 800, lengthMm: 800 * 0.2 });
  assert.equal(a.toFixed(6), b.toFixed(6));
  assert.equal(ctrRatio({ lengthPx: 400, lengthMm: null }, { lengthPx: 800, lengthMm: null }), 0.5);
});

test("an erect PA ratio of 0.50 or less is normal and the sentence reads like the example", () => {
  const said = ctrSentence(heart(105), thorax(275), "PA");
  assert.equal(said.text, "Cardiothoracic ratio is normal, 10.5 : 27.5.");
  assert.equal(said.abnormal, false);
  assert.equal(ctrSentence(heart(100), thorax(200), "PA").abnormal, false, "exactly 0.50 is normal");
  assert.equal(CTR_PA_LIMIT, 0.5);
});

test("above 0.50 on a PA film the sentence says the ratio is increased and is abnormal", () => {
  const said = ctrSentence(heart(140), thorax(250), "PA");
  assert.equal(said.text, "Cardiothoracic ratio is increased, 14.0 : 25.0.");
  assert.equal(said.abnormal, true);
});

test("each diameter is rounded to one decimal in the sentence", () => {
  assert.equal(ctrSentence(heart(104.96), thorax(274.64), "PA").text, "Cardiothoracic ratio is normal, 10.5 : 27.5.");
});

test("AP, supine or unknown: the ratio is written, not called normal, and not abnormal", () => {
  const ap = ctrSentence(heart(140), thorax(250), "AP");
  assert.ok(ap.text.includes("0.56") && ap.text.includes("14.0 : 25.0"), ap.text);
  assert.ok(ap.text.includes("AP images may have variable source distance"), ap.text);
  assert.ok(ap.text.includes("not applied"), ap.text);
  assert.equal(ap.abnormal, false);
  const supine = ctrSentence(heart(140), thorax(250), "AP supine");
  assert.ok(supine.text.includes("AP supine"), supine.text);
  assert.ok(supine.text.includes("not applied automatically"), supine.text);
  assert.equal(supine.abnormal, false);
  const unknown = ctrSentence(heart(140), thorax(250), "");
  assert.ok(unknown.text.includes("not recorded"), unknown.text);
  assert.equal(unknown.abnormal, false);
  for (const said of [ap, supine, unknown]) {
    assert.ok(!/\bis (?:normal|increased)\b/.test(said.text), said.text);
  }
});

test("with no spacing the sentence gives the ratio only, never centimetres", () => {
  const said = ctrSentence({ lengthPx: 400, lengthMm: null }, { lengthPx: 800, lengthMm: null }, "PA");
  assert.equal(said.text, "Cardiothoracic ratio is normal, 0.50.");
  assert.ok(!/cm/.test(said.text));
});

console.log("\n=== boxes and descriptions ===");

test("a box around the heart line spans the line and stays on the film", () => {
  const box = boxAroundLine({ x1: 30, y1: 55, x2: 70, y2: 55 });
  assert.ok(box[0] <= 30 && box[0] + box[2] >= 70);
  assert.ok(box.every((n) => n >= 0) && box[0] + box[2] <= 100 && box[1] + box[3] <= 100);
});

test("the heart size description gives both diameters, the ratio, the threshold and the limitation", () => {
  const tag = { key: "t4", kind: "ctr" };
  const lines = [
    { tagKey: "t4", kind: "ctr-heart", lengthPx: 1400, lengthMm: 140, spacingTag: "ImagerPixelSpacing" },
    { tagKey: "t4", kind: "ctr-thorax", lengthPx: 2500, lengthMm: 250, spacingTag: "ImagerPixelSpacing" },
  ];
  const text = describeMeasurement(tag, lines, { view: "PA" }).join("\n");
  assert.ok(text.includes("Greatest transverse cardiac diameter: 14.0 cm film size."));
  assert.ok(text.includes("Greatest inner thoracic diameter: 25.0 cm film size."));
  assert.ok(text.includes("Cardiothoracic ratio: 0.56 (14.0 : 25.0)."));
  assert.ok(text.includes("0.50 or below is normal"));
  assert.ok(text.includes("Body-size estimate unavailable"));
  assert.ok(text.includes("Imager Pixel Spacing (0018,1164)"));
});

test("on a non-PA view the threshold is not applied", () => {
  const tag = { key: "t4", kind: "ctr" };
  const lines = [
    { tagKey: "t4", kind: "ctr-heart", lengthPx: 1400, lengthMm: 140, spacingTag: "PixelSpacing" },
    { tagKey: "t4", kind: "ctr-thorax", lengthPx: 2500, lengthMm: 250, spacingTag: "PixelSpacing" },
  ];
  const text = describeMeasurement(tag, lines, { view: "AP" }).join("\n");
  assert.ok(text.includes("not applied"));
  assert.ok(text.includes("Pixel Spacing (0028,0030)"));
});

test("a lesion description gives the film-size length, names the tag and states the limitation", () => {
  const tag = { key: "t1" };
  const text = describeMeasurement(tag, [{ tagKey: "t1", kind: "lesion", lengthPx: 500, lengthMm: 50, spacingTag: "ImagerPixelSpacing" }]).join("\n");
  assert.ok(text.includes("Film-size length: 5.00 cm."));
  assert.ok(text.includes("Imager Pixel Spacing (0018,1164)"));
  assert.ok(text.includes(LIMITATION));
});

test("with no spacing the description says centimetres are unavailable", () => {
  const text = describeMeasurement({ key: "t1" }, [{ tagKey: "t1", kind: "lesion", lengthPx: 245, lengthMm: null }]).join("\n");
  assert.ok(text.includes("Centimetres are unavailable"));
  assert.ok(text.includes("245 px"));
  assert.ok(text.includes(LIMITATION));
  assert.ok(!/\d\s*cm\b/.test(text));
});

test("a finding without a line says so", () => {
  assert.deepEqual(describeMeasurement({ key: "t9" }, []), ["No measurement was drawn for this finding."]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
