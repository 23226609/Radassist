// src/lib/measure.js
// Lines drawn on the film, and what they mean.
//
// A line on the film is the shadow on the detector, after magnification.
// Centimetres on the film come from Imager Pixel Spacing (0018,1164). A body
// size is shown only when the file records a patient-plane calibration. An
// erect PA film with no calibration may show a separate experimental estimate.
// AP, supine, an unrecorded view, and a projection conflict do not.

import { cleanView } from "../../shared/reportTags.js";

export const SPACING_NAMES = {
  ImagerPixelSpacing: "Imager Pixel Spacing (0018,1164)",
  PixelSpacing: "Pixel Spacing (0028,0030)",
};

// Cardiothoracic ratio: at or below this is normal on an erect PA film.
export const CTR_PA_LIMIT = 0.5;

export const LIMITATION = "The film centimetres are the size of the shadow on the detector.";

export const MAGNIFICATION_NAMES = {
  PixelSpacing: "Pixel Spacing (0028,0030), the vendor's patient-plane calibration",
  EstimatedRadiographicMagnificationFactor: "Estimated Radiographic Magnification Factor (0018,1114)",
  MidPlane: "the mid-chest plane, from Distance Source to Detector (0018,1110) and Body Part Thickness (0018,11A0)",
  SupportPlane: "the plane against the detector, from Distance Source to Detector (0018,1110) and Distance Source to Patient (0018,1111)",
  HkPaStandard: "the Hong Kong erect PA standard, 180 cm focus-to-film",
};

// Hong Kong Hospital Authority departments take an erect PA chest at 180 cm
// focus-to-film (Hong Kong Journal of Radiology, regional-hospital series).
// The file rarely records how far the measured point sits in front of the
// detector. For a trial, the mid-chest is taken as 11 cm: half of a made-up
// 22 cm adult chest, with the front of the chest against the detector.
export const HK_PA_SID_MM = 1800;
export const HK_PA_OID_MM = 110;

// A chest projection magnifies, but not by an arbitrary amount. Outside this
// range the tag is not a usable chest-film correction.
const MIN_FACTOR = 1.01;
const MAX_FACTOR = 1.8;

function pair(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const row = Number(value[0]);
  const col = Number(value[1]);
  return row > 0 && col > 0 ? [row, col] : null;
}

// The spacing used for every centimetre shown, and which tag supplied it.
// `adjust` is the {row, col} scale the API reports when the film on screen is
// a smaller copy of the stored one.
export function spacingOf(c = {}, adjust = null) {
  const imager = pair(c.imagerPixelSpacingMm);
  const used = imager || pair(c.pixelSpacingMm);
  if (!used) return { mm: null, source: "", name: "" };
  let source = "";
  if (imager) source = "ImagerPixelSpacing";
  else if (c.pixelSpacingSource === "ImagerPixelSpacing" || c.pixelSpacingSource === "PixelSpacing") source = c.pixelSpacingSource;
  else if (pair(c.dicomPixelSpacingMm)) source = "PixelSpacing";
  return {
    mm: [used[0] * (adjust?.row || 1), used[1] * (adjust?.col || 1)],
    source,
    name: SPACING_NAMES[source] || "pixel spacing (the tag was not recorded)",
  };
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// Pixel geometry of a line whose ends are % of a film that is width x height.
export function lineGeometry(line, width, height) {
  const dx = ((Number(line.x2) - Number(line.x1)) / 100) * width;
  const dy = ((Number(line.y2) - Number(line.y1)) / 100) * height;
  return { dxPx: dx, dyPx: dy, lengthPx: Math.hypot(dx, dy) };
}

// Millimetres on the film along the line, or null when there is no spacing.
export function filmMm(geometry, spacing) {
  if (!spacing?.mm) return null;
  return Math.hypot(geometry.dxPx * spacing.mm[1], geometry.dyPx * spacing.mm[0]);
}

const KIND_NAME = { "ctr-heart": "Heart", "ctr-thorax": "Thorax" };

function scaledPair(value, adjust) {
  const p = pair(value);
  if (!p) return null;
  return [p[0] * (adjust?.row || 1), p[1] * (adjust?.col || 1)];
}

function usableFactor(value) {
  const n = Number(value);
  return n >= MIN_FACTOR && n <= MAX_FACTOR ? n : null;
}

// How a film length becomes a body length, from the tags this file recorded.
// The first one that is present and sane wins:
//   1. Pixel Spacing smaller than Imager Pixel Spacing. That difference is the
//      vendor's calibration to the patient plane (DICOM CP-586).
//   2. Estimated Radiographic Magnification Factor (0018,1114), SID / SOD.
//   3. Distance Source to Detector and Body Part Thickness: the line is taken
//      at half the thickness in front of the detector, plus a grid gap of at
//      most 80 mm when Distance Source to Patient records one.
//   4. Distance Source to Detector and Distance Source to Patient alone: the
//      size in the plane against the detector, not deeper in the chest.
// Same spacing twice, or no distances, means there is no patient-plane calibration.
// The 180 cm departmental distance is not a calibration. It is offered only as
// a separate experimental estimate, and only for an erect PA film with no conflict.
export function magnificationOf(c = {}, adjust = null) {
  const imager = scaledPair(c.imagerPixelSpacingMm, adjust);
  const pixel = scaledPair(c.dicomPixelSpacingMm, adjust);
  if (imager && pixel) {
    const factor = Math.sqrt((imager[0] / pixel[0]) * (imager[1] / pixel[1]));
    if (usableFactor(factor)) {
      return {
        factor,
        source: "PixelSpacing",
        name: MAGNIFICATION_NAMES.PixelSpacing,
        pixelMm: pixel,
        detail: "Pixel Spacing is smaller than Imager Pixel Spacing, so it is the vendor's size in the patient.",
      };
    }
  }

  const estimated = usableFactor(c.estimatedMagnification);
  if (estimated) {
    return {
      factor: estimated,
      source: "EstimatedRadiographicMagnificationFactor",
      name: MAGNIFICATION_NAMES.EstimatedRadiographicMagnificationFactor,
      detail: "The modality stored this ratio of source-to-detector distance over source-to-object distance.",
    };
  }

  const sid = Number(c.distanceSourceToDetectorMm);
  const support = Number(c.distanceSourceToPatientMm);
  const thickness = Number(c.bodyPartThicknessMm);
  const sidOk = sid > 0;
  const airGap = sidOk && support > 0 && sid > support ? Math.min(sid - support, 80) : 0;
  if (sidOk && thickness > 0 && thickness < sid) {
    const oid = thickness / 2 + airGap;
    const sod = sid - oid;
    const factor = sod > 0 ? usableFactor(sid / sod) : null;
    if (factor) {
      return {
        factor,
        source: "MidPlane",
        name: MAGNIFICATION_NAMES.MidPlane,
        detail: "Mid-chest estimate. A lesion not halfway through the chest differs from this.",
      };
    }
  }
  if (sidOk && support > 0 && sid > support) {
    const factor = usableFactor(sid / support);
    if (factor) {
      return {
        factor,
        source: "SupportPlane",
        name: MAGNIFICATION_NAMES.SupportPlane,
        detail: "This is the size in the plane against the detector. A structure deeper in the chest is slightly smaller.",
      };
    }
  }
  return null;
}

// Words in the DICOM header, or in a description, that disagree with an erect PA view.
export function projectionSignals(c = {}) {
  const viewPosition = String(c.dicomViewPosition || "").trim().toUpperCase();
  const patientPosition = String(c.patientPosition || "").trim().toUpperCase();
  const cues = String(c.projectionCues || "");
  const blob = `${viewPosition} ${patientPosition} ${cues}`.toUpperCase();
  const supine = /\bSUPINE\b/.test(blob) || patientPosition === "HFS" || patientPosition === "FFS";
  const portable = /\bPORTABLE\b/.test(blob);
  let recorded = "";
  if (viewPosition === "AP" && supine) recorded = "AP supine";
  else if (viewPosition === "AP") recorded = "AP";
  else if (viewPosition === "PA" && (supine || portable)) recorded = supine ? "AP supine" : "AP";
  else if (viewPosition === "PA") recorded = "PA";
  else if (viewPosition === "LATERAL" || viewPosition === "LAT" || viewPosition === "LL" || viewPosition === "RL" || /\bLATERAL\b/.test(viewPosition)) recorded = "Lateral";
  else if (supine) recorded = "AP supine";
  else if (portable) recorded = "AP";
  return { viewPosition, patientPosition, cues, supine, portable, recorded };
}

export function hasProjectionConflict(c = {}) {
  const selected = cleanView(c.view);
  const signals = projectionSignals(c);
  if (!signals.viewPosition && !signals.patientPosition && !signals.cues.trim()) return false;
  if (selected === "PA" && (signals.supine || signals.portable || signals.recorded === "AP" || signals.recorded === "AP supine")) return true;
  if (selected && signals.recorded && selected !== signals.recorded) return true;
  return false;
}

function conflictReason(c) {
  const signals = projectionSignals(c);
  const selected = cleanView(c.view);
  if (selected === "PA" && (signals.portable || signals.supine)) {
    return "Projection conflict detected. The selected view is PA erect, but the image or metadata contains \"PORTABLE\" or \"SUPINE\". Body-size estimation has been disabled. Please verify the projection.";
  }
  const recorded = signals.recorded || signals.viewPosition || "a different projection";
  const selectedName = selected === "PA" ? "PA erect" : (selected || "not recorded");
  return `Projection conflict detected. The selected view is ${selectedName}, but the image or metadata records ${recorded}. Body-size estimation has been disabled. Please verify the projection.`;
}

function projectionCode(view) {
  const v = cleanView(view);
  if (v === "PA") return "PA_ERECT";
  if (v === "AP") return "AP";
  if (v === "AP supine") return "AP_SUPINE";
  if (v === "Lateral") return "LATERAL";
  return "UNKNOWN";
}

// Whether a body size may be shown, and why it may not.
export function getMeasurementPolicy(c = {}, adjust = null) {
  const projection = projectionCode(c.view);
  const magnification = magnificationOf(c, adjust);
  if (hasProjectionConflict(c)) {
    return {
      projection,
      showFilmMeasurement: true,
      showBodyMeasurement: false,
      showExperimentalEstimate: false,
      showCtr: true,
      classifyCtr: false,
      conflict: true,
      magnification: null,
      reason: conflictReason(c),
    };
  }
  if (magnification) {
    return {
      projection,
      showFilmMeasurement: true,
      showBodyMeasurement: true,
      showExperimentalEstimate: false,
      showCtr: true,
      classifyCtr: projection === "PA_ERECT",
      conflict: false,
      magnification,
      reason: "Patient-plane calibration is available.",
    };
  }
  if (projection === "PA_ERECT") {
    return {
      projection,
      showFilmMeasurement: true,
      showBodyMeasurement: false,
      showExperimentalEstimate: true,
      showCtr: true,
      classifyCtr: true,
      conflict: false,
      magnification: null,
      reason: "No calibrated body measurement is available.",
    };
  }
  if (projection === "AP") {
    return {
      projection,
      showFilmMeasurement: true,
      showBodyMeasurement: false,
      showExperimentalEstimate: false,
      showCtr: true,
      classifyCtr: false,
      conflict: false,
      magnification: null,
      reason: "AP images may have variable source distance and magnification. No patient-plane calibration was recorded.",
    };
  }
  if (projection === "AP_SUPINE") {
    return {
      projection,
      showFilmMeasurement: true,
      showBodyMeasurement: false,
      showExperimentalEstimate: false,
      showCtr: true,
      classifyCtr: false,
      conflict: false,
      magnification: null,
      reason: "AP supine images do not use the assumed 180 cm erect-PA geometry. The source distance and object depth were not recorded.",
    };
  }
  if (projection === "LATERAL") {
    return {
      projection,
      showFilmMeasurement: true,
      showBodyMeasurement: false,
      showExperimentalEstimate: false,
      showCtr: true,
      classifyCtr: false,
      conflict: false,
      magnification: null,
      reason: "A lateral film is not an erect PA view. Body size and the 0.50 cardiothoracic threshold are not applied.",
    };
  }
  return {
    projection,
    showFilmMeasurement: true,
    showBodyMeasurement: false,
    showExperimentalEstimate: false,
    showCtr: true,
    classifyCtr: false,
    conflict: false,
    magnification: null,
    reason: "Projection and calibration information were not recorded.",
  };
}

// The made-up mid-chest trial. Not a measurement of this patient.
export function experimentalBody(lengthMm) {
  const film = Number(lengthMm);
  if (!(film > 0)) return null;
  const factor = HK_PA_SID_MM / (HK_PA_SID_MM - HK_PA_OID_MM);
  return { bodyMm: Math.round((film / factor) * 100) / 100, factor: Math.round(factor * 1000) / 1000 };
}

export function experimentalLabel(line) {
  const est = experimentalBody(line?.lengthMm);
  if (!est) return "";
  const places = KIND_NAME[line.kind] ? 1 : 2;
  return `Experimental estimate: ${(est.bodyMm / 10).toFixed(places)} cm`;
}

export const EXPERIMENTAL_NOTE = "Assumes 180 cm source-to-detector distance and an unmeasured object depth of 11 cm. Not DICOM-calibrated.";

// What the line says on the film and in the list.
export function lineText({ kind = "lesion", lengthPx, lengthMm, bodyLengthMm, magnification }) {
  const who = KIND_NAME[kind];
  const prefix = who ? `${who} ` : "";
  if (lengthMm == null) return `${prefix}${Math.round(lengthPx)} px`;
  const places = who ? 1 : 2;
  const film = (lengthMm / 10).toFixed(places);
  const factor = Number(magnification);
  if (!(bodyLengthMm > 0) || !(factor >= MIN_FACTOR) || arguments[0]?.magnificationSource === "HkPaStandard") {
    return who ? `${prefix}${film} cm film · Body size unavailable` : `Film ${film} cm · Body size unavailable`;
  }
  const body = (bodyLengthMm / 10).toFixed(places);
  return `${prefix}${body} cm body · ×${showFactor(factor)} · film ${film} cm`;
}

// Two decimals when the third is zero (×1.25), otherwise three (×1.065).
export function showFactor(factor) {
  const text = (Math.round(Number(factor) * 1000) / 1000).toFixed(3);
  return text.endsWith("0") ? text.slice(0, -1) : text;
}

// Attach body size when the file's geometry supports it. The stored film
// length is left as it is.
export function applyMagnification(line, magnification) {
  if (!line) return line;
  if (line.lengthMm == null) return { ...line, text: line.text || lineText(line) };
  let body = null;
  let factor = null;
  if (magnification?.factor >= MIN_FACTOR) {
    const pixel = magnification.pixelMm;
    if (pixel && Number.isFinite(Number(line.dxPx)) && Number.isFinite(Number(line.dyPx))) {
      body = Math.hypot(Number(line.dxPx) * pixel[1], Number(line.dyPx) * pixel[0]);
      if (body > 0 && body < line.lengthMm) factor = line.lengthMm / body;
    }
    if (!(body > 0) || !(factor >= MIN_FACTOR)) {
      factor = magnification.factor;
      body = line.lengthMm / factor;
    }
    if (!(body > 0) || !(factor >= MIN_FACTOR) || body >= line.lengthMm) {
      body = null;
      factor = null;
    }
  }
  const row = {
    ...line,
    bodyLengthMm: body == null ? null : round(body, 2),
    magnification: factor == null ? null : round(factor, 3),
    magnificationSource: body == null ? "" : (magnification.source || ""),
  };
  return { ...row, text: lineText(row) };
}

export function buildLine(line, { width, height, spacing, kind = "lesion", tagKey = "", magnification = null }) {
  const g = lineGeometry(line, width, height);
  const mm = filmMm(g, spacing);
  const row = {
    x1: round(line.x1, 2),
    y1: round(line.y1, 2),
    x2: round(line.x2, 2),
    y2: round(line.y2, 2),
    kind,
    tagKey,
    dxPx: round(g.dxPx, 1),
    dyPx: round(g.dyPx, 1),
    lengthPx: round(g.lengthPx, 1),
    lengthMm: mm == null ? null : round(mm, 2),
    spacingTag: mm == null ? "" : spacing.source,
    label: "",
  };
  return applyMagnification(row, magnification);
}

export function linesOfTag(measurements, tagKey) {
  return (Array.isArray(measurements) ? measurements : []).filter((m) => tagKey && m.tagKey === tagKey);
}

export function ctrLines(measurements, tagKey) {
  const lines = linesOfTag(measurements, tagKey);
  return {
    heart: lines.find((m) => m.kind === "ctr-heart") || null,
    thorax: lines.find((m) => m.kind === "ctr-thorax") || null,
  };
}

// Heart diameter over thoracic diameter. Both lines are measured with the same
// row and column spacing, so which spacing tag gave the centimetres does not
// change the ratio. With no spacing the pixel lengths are used.
export function ctrRatio(heart, thorax) {
  if (!heart || !thorax) return null;
  const both = heart.lengthMm != null && thorax.lengthMm != null;
  const top = both ? Number(heart.lengthMm) : Number(heart.lengthPx);
  const bottom = both ? Number(thorax.lengthMm) : Number(thorax.lengthPx);
  if (!(top > 0) || !(bottom > 0)) return null;
  return top / bottom;
}

function diameters(heart, thorax) {
  if (heart?.bodyLengthMm > 0 && thorax?.bodyLengthMm > 0) {
    return [heart.bodyLengthMm / 10, thorax.bodyLengthMm / 10];
  }
  if (heart?.lengthMm == null || thorax?.lengthMm == null) return null;
  return [heart.lengthMm / 10, thorax.lengthMm / 10];
}

// "Cardiothoracic ratio is normal, 10.5 : 27.5." Only an erect PA film with no
// projection conflict is called normal or increased. Every other case keeps
// the ratio and says why the PA threshold is not used.
export function ctrSentence(heart, thorax, view, policy = null) {
  const ratio = ctrRatio(heart, thorax);
  if (ratio == null) return null;
  const decided = policy || getMeasurementPolicy({ view });
  const cm = diameters(heart, thorax);
  const figures = cm ? `${cm[0].toFixed(1)} : ${cm[1].toFixed(1)}` : "";
  if (decided.classifyCtr) {
    const normal = ratio <= CTR_PA_LIMIT + 1e-9;
    return {
      ratio,
      abnormal: !normal,
      text: `Cardiothoracic ratio is ${normal ? "normal" : "increased"}, ${figures || ratio.toFixed(2)}.`,
    };
  }
  const value = figures ? `${ratio.toFixed(2)} (${figures})` : ratio.toFixed(2);
  const auto = decided.projection === "AP_SUPINE" ? " automatically" : "";
  return {
    ratio,
    abnormal: false,
    text: `Cardiothoracic ratio is ${value}. ${decided.reason} The PA threshold of ${CTR_PA_LIMIT.toFixed(2)} is not applied${auto}.`,
  };
}

// A box around a line. For the heart line it spans the heart's width and
// reaches up and down from the line.
export function boxAroundLine(line) {
  const x1 = Math.min(Number(line.x1), Number(line.x2));
  const x2 = Math.max(Number(line.x1), Number(line.x2));
  const y1 = Math.min(Number(line.y1), Number(line.y2));
  const y2 = Math.max(Number(line.y1), Number(line.y2));
  const width = x2 - x1 + 6;
  const half = Math.max((y2 - y1) / 2 + 6, (x2 - x1) * 0.35);
  const midY = (y1 + y2) / 2;
  const left = Math.max(0, Math.min(97, x1 - 3));
  const top = Math.max(0, Math.min(97, midY - half));
  const w = Math.min(100 - left, Math.max(3, width));
  const h = Math.min(100 - top, Math.max(3, half * 2));
  return [left, top, w, h].map((n) => round(n, 2));
}

function figure(m) {
  if (m.lengthMm == null) return `${Math.round(m.lengthPx)} px`;
  const places = m.kind === "lesion" ? 2 : 1;
  const film = `${(m.lengthMm / 10).toFixed(places)} cm film size`;
  if (!(m.bodyLengthMm > 0)) return film;
  return `${(m.bodyLengthMm / 10).toFixed(places)} cm in the body (${film}, ×${showFactor(m.magnification)})`;
}

function sourceSentence(lines, fallbackName) {
  const tag = lines.map((m) => m.spacingTag).find(Boolean);
  const name = tag ? SPACING_NAMES[tag] : fallbackName;
  return name ? `Spacing taken from ${name}.` : "";
}

// The short description printed under a finding's film in the second download.
export function describeMeasurement(tag, measurements, { view = "", spacingName = "", case: source = null } = {}) {
  const policy = getMeasurementPolicy({ ...(source || {}), view: view || source?.view || "" });
  const lines = linesOfTag(measurements, tag?.key);
  if (!lines.length) return ["No measurement was drawn for this finding."];
  const { heart, thorax } = ctrLines(measurements, tag.key);
  const useBody = (m) => policy.showBodyMeasurement && m?.bodyLengthMm > 0 && m.magnificationSource !== "HkPaStandard";
  if (tag.kind === "ctr" && heart && thorax) {
    const ratio = ctrRatio(heart, thorax);
    const shown = useBody(heart) && useBody(thorax) ? diameters(heart, thorax) : (
      heart.lengthMm != null && thorax.lengthMm != null ? [heart.lengthMm / 10, thorax.lengthMm / 10] : null
    );
    const out = [
      `Greatest transverse cardiac diameter: ${useBody(heart) ? figure(heart) : (heart.lengthMm == null ? `${Math.round(heart.lengthPx)} px` : `${(heart.lengthMm / 10).toFixed(1)} cm film size`)}.`,
      `Greatest inner thoracic diameter: ${useBody(thorax) ? figure(thorax) : (thorax.lengthMm == null ? `${Math.round(thorax.lengthPx)} px` : `${(thorax.lengthMm / 10).toFixed(1)} cm film size`)}.`,
      `Cardiothoracic ratio: ${ratio.toFixed(2)}${shown ? ` (${shown.map((n) => n.toFixed(1)).join(" : ")})` : ""}.`,
      policy.classifyCtr
        ? `On an erect PA film a ratio of ${CTR_PA_LIMIT.toFixed(2)} or below is normal.`
        : `The PA threshold of ${CTR_PA_LIMIT.toFixed(2)} is not applied. ${policy.reason}`,
    ];
    if (heart.lengthMm == null || thorax.lengthMm == null) {
      out.push("Centimetres are unavailable: this film has no pixel spacing.");
    } else if (useBody(heart) && useBody(thorax)) {
      out.push(`The ratio is the same on the film and in the body. Body size uses ${MAGNIFICATION_NAMES[heart.magnificationSource] || "the file's geometry"}.`);
      out.push(LIMITATION);
    } else {
      out.push("These centimetres are the size on the film.");
      out.push(`Body-size estimate unavailable. ${policy.reason}`);
      out.push(sourceSentence([heart, thorax], spacingName));
    }
    return out.filter(Boolean);
  }
  const m = lines[0];
  const out = [];
  if (!Number.isFinite(Number(m.lengthPx))) {
    // Drawn before film sizes were stored: only the text is known.
    out.push(`Recorded measurement: ${String(m.text || "").trim() || "none"}.`);
    out.push("The spacing tag behind this number was not recorded.");
  } else if (m.lengthMm == null) {
    out.push(`Centimetres are unavailable: this film has no pixel spacing. Length on the film: ${Math.round(m.lengthPx)} px.`);
    out.push(LIMITATION);
  } else if (policy.showBodyMeasurement && m.bodyLengthMm > 0 && m.magnificationSource !== "HkPaStandard") {
    out.push(`Size in the body: ${(m.bodyLengthMm / 10).toFixed(2)} cm at magnification ×${showFactor(m.magnification)}.`);
    out.push(`Film-size length: ${(m.lengthMm / 10).toFixed(2)} cm.`);
    out.push(`Magnification from ${MAGNIFICATION_NAMES[m.magnificationSource] || "the file's geometry"}.`);
    out.push(LIMITATION);
  } else {
    out.push(`Film-size length: ${(m.lengthMm / 10).toFixed(2)} cm.`);
    out.push(sourceSentence([m], spacingName));
    out.push(`Body-size estimate unavailable. ${policy.reason}`);
    if (policy.showExperimentalEstimate) {
      const label = experimentalLabel(m);
      if (label) out.push(`${label}. ${EXPERIMENTAL_NOTE}`);
    }
    out.push(LIMITATION);
  }
  return out.filter(Boolean);
}
