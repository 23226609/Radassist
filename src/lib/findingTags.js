// src/lib/findingTags.js
// Helpers the review page and the downloads share for sentence tags and the
// film boxes linked to them.

import { makeTag as newTag } from "../../shared/reportTags.js";
import { boxAroundLine, ctrLines, ctrSentence, lineText, linesOfTag, getMeasurementPolicy, applyMagnification } from "./measure.js";

export { isNormalSentence, makeTag, nextTagKey, tagsFromText, ensureTags, assembleReport, deriveFromReport } from "../../shared/reportTags.js";

export function boxOf(finding) {
  const b = finding?.bbox;
  if (!Array.isArray(b) || b.length !== 4) return null;
  if (!b.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (b[2] <= 0 || b[3] <= 0) return null;
  return b;
}

export const isRejected = (f) => f?.status === "rejected";

// Boxes shown on the film for one tag. A rejected box is gone from the film.
export function boxesForTag(findings, tagKey) {
  if (!tagKey) return [];
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f?.tagKey === tagKey && !isRejected(f) && boxOf(f));
}

export function tagOfBox(tags, finding) {
  return (Array.isArray(tags) ? tags : []).find((t) => t.key === finding?.tagKey) || null;
}

// Moves one tag to a new position; the list is returned as a new array.
export function moveTag(tags, fromKey, toKey, after = false) {
  const list = [...(Array.isArray(tags) ? tags : [])];
  const from = list.findIndex((t) => t.key === fromKey);
  if (from < 0 || fromKey === toKey) return list;
  const [item] = list.splice(from, 1);
  let to = list.findIndex((t) => t.key === toKey);
  if (to < 0) to = list.length;
  else if (after) to += 1;
  list.splice(to, 0, item);
  return list;
}

export function sameOrder(a, b) {
  const ka = (a || []).map((t) => t.key).join("|");
  const kb = (b || []).map((t) => t.key).join("|");
  return ka === kb;
}

// ------------------------------------------------------------------------
// Edits to a case's tags, boxes and measurement lines. Each takes a case and
// returns a new one; the review page keeps the result as its working copy.

let counter = 0;
const tmpId = () => `tmp-${Date.now()}-${++counter}-${Math.random().toString(16).slice(2, 5)}`;

const tagsOf = (c) => (Array.isArray(c?.findingTags) ? c.findingTags : []);
const findingsOf = (c) => (Array.isArray(c?.findings) ? c.findings : []);
const linesOfCase = (c) => (Array.isArray(c?.measurements) ? c.measurements : []);
const tagByKey = (c, key) => tagsOf(c).find((t) => t.key === key) || null;

export function isDrawnBox(f) {
  return String(f?.source || "").toLowerCase() === "manual";
}

function boxRow(tag, bbox) {
  const id = tmpId();
  return {
    _id: id,
    id,
    label: String(tag.text || "").slice(0, 80) || "Marked area",
    bbox,
    tagKey: tag.key,
    source: "manual",
    bboxSource: "manual",
    status: "pending",
    severity: "",
    confidence: 1,
    pattern: "Other",
    sentence: String(tag.text || "").slice(0, 240),
    location: "",
    size: "",
  };
}

const withTags = (c, tags) => ({ ...c, findingTags: tags });
const patchTag = (c, key, patch) => withTags(c, tagsOf(c).map((t) => (t.key === key ? { ...t, ...patch } : t)));
const dropBoxes = (c, key) => ({ ...c, findings: findingsOf(c).filter((f) => f.tagKey !== key) });

// The tag's box, if the radiologist or Azure placed one.
export function boxOfTag(c, key) {
  return boxesForTag(findingsOf(c), key)[0] || null;
}

export function addTag(c, text, extra = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return { c, tag: null };
  const tag = newTag(clean, tagsOf(c), { manual: true, ...extra });
  return { c: withTags(c, [...tagsOf(c), tag]), tag };
}

export function setTagText(c, key, text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const next = patchTag(c, key, { text: clean });
  return {
    ...next,
    findings: findingsOf(next).map((f) => (f.tagKey === key ? { ...f, label: clean.slice(0, 80) || f.label, sentence: clean.slice(0, 240) } : f)),
  };
}

export function deleteTag(c, key) {
  return {
    ...withTags(c, tagsOf(c).filter((t) => t.key !== key)),
    findings: findingsOf(c).filter((f) => f.tagKey !== key),
    measurements: linesOfCase(c).filter((m) => m.tagKey !== key),
  };
}

// Normal sentences have no box. Switching one to abnormal leaves it without a
// box until Azure or the radiologist adds one; a ratio sentence is boxed on
// its heart line straight away.
export function flipTag(c, key) {
  const tag = tagByKey(c, key);
  if (!tag) return c;
  if (tag.abnormal) return patchTag(dropBoxes(c, key), key, { abnormal: false, boxDeclined: false });
  const next = patchTag(c, key, { abnormal: true });
  return tag.kind === "ctr" ? ensureCtrBox(next, key) : next;
}

export function moveTagTo(c, fromKey, toKey, after = false) {
  return withTags(c, moveTag(tagsOf(c), fromKey, toKey, after));
}

// Deleting a box is a decision: Azure must not put it back.
export function removeBox(c, key) {
  const next = {
    ...c,
    findings: findingsOf(c)
      .filter((f) => !(f.tagKey === key && isDrawnBox(f)))
      .map((f) => (f.tagKey === key ? { ...f, status: "rejected" } : f)),
  };
  return patchTag(next, key, { boxDeclined: true });
}

export function placeBox(c, key, bbox) {
  const tag = tagByKey(c, key);
  if (!tag) return c;
  const next = patchTag(dropBoxes(c, key), key, { abnormal: true, boxDeclined: false });
  return { ...next, findings: [...findingsOf(next), boxRow(tagByKey(next, key), bbox)] };
}

export function moveBox(c, key, bbox) {
  const box = boxOfTag(c, key);
  if (!box) return c;
  return { ...c, findings: findingsOf(c).map((f) => (f === box ? { ...f, bbox, bboxSource: "manual" } : f)) };
}

// A box drawn with no tag chosen starts a new finding at the end of the list.
export function drawnFinding(c, bbox) {
  const { c: next, tag } = addTag(c, "Marked area", { abnormal: true });
  return { c: { ...next, findings: [...findingsOf(next), boxRow(tag, bbox)] }, tag };
}

// ---- the cardiothoracic ratio

function ensureCtrBox(c, key) {
  const { heart } = ctrLines(linesOfCase(c), key);
  const tag = tagByKey(c, key);
  if (!heart || !tag || tag.boxDeclined || boxOfTag(c, key)) return c;
  return { ...c, findings: [...findingsOf(c), boxRow(tag, boxAroundLine(heart))] };
}

function applyCtrSentence(c, key) {
  const policy = getMeasurementPolicy(c);
  const measurements = linesOfCase(c).map((m) => (
    m.tagKey === key && (m.kind === "ctr-heart" || m.kind === "ctr-thorax")
      ? applyMagnification(m, policy.showBodyMeasurement ? policy.magnification : null)
      : m
  ));
  c = { ...c, measurements };
  const { heart, thorax } = ctrLines(measurements, key);
  const said = ctrSentence(heart, thorax, c.view, policy);
  if (!said) return c;
  const text = said.text;
  let next = patchTag(c, key, { text, abnormal: said.abnormal });
  next = {
    ...next,
    findings: findingsOf(next).map((f) => (f.tagKey === key ? { ...f, label: text.slice(0, 80), sentence: text.slice(0, 240) } : f)),
  };
  if (!said.abnormal) return dropBoxes(next, key);
  return ensureCtrBox(next, key);
}

// The radiologist drew the two diameters. The sentence and its box follow.
export function setCtr(c, heart, thorax) {
  let tag = tagsOf(c).find((t) => t.kind === "ctr");
  let next = c;
  if (tag) {
    next = {
      ...c,
      findings: findingsOf(c).filter((f) => f.tagKey !== tag.key),
      measurements: linesOfCase(c).filter((m) => m.tagKey !== tag.key),
    };
    next = patchTag(next, tag.key, { boxDeclined: false });
  } else {
    ({ c: next, tag } = addTag(c, "Cardiothoracic ratio.", { kind: "ctr", abnormal: false }));
  }
  next = {
    ...next,
    measurements: [
      ...linesOfCase(next),
      { ...heart, kind: "ctr-heart", tagKey: tag.key, _id: tmpId() },
      { ...thorax, kind: "ctr-thorax", tagKey: tag.key, _id: tmpId() },
    ],
  };
  return { c: applyCtrSentence(next, tag.key), key: tag.key };
}

// The view decides whether the ratio is normal, so it is worded again.
export function refreshCtr(c) {
  const tag = tagsOf(c).find((t) => t.kind === "ctr");
  if (!tag) return c;
  const { heart, thorax } = ctrLines(linesOfCase(c), tag.key);
  return heart && thorax ? applyCtrSentence(c, tag.key) : c;
}

// ---- a single lesion line

const CLAUSE = /,\s*measuring\s.*$/i;

function withMeasurement(text, clause) {
  const base = String(text || "").replace(CLAUSE, "").replace(/[.\s]+$/, "");
  return clause ? `${base}, measuring ${clause}.` : `${base}.`;
}

// The measurement is written into the linked sentence. With no tag chosen the
// line starts a new abnormal finding, boxed around the line.
export function addLesionLine(c, line, selectedKey = "") {
  const clause = lineText(line);
  const chosen = tagByKey(c, selectedKey);
  if (chosen && chosen.abnormal && chosen.kind !== "ctr") {
    let next = {
      ...c,
      measurements: [...linesOfCase(c).filter((m) => !(m.tagKey === chosen.key && m.kind === "lesion")), { ...line, tagKey: chosen.key, kind: "lesion", _id: tmpId() }],
    };
    next = setTagText(next, chosen.key, withMeasurement(chosen.text, clause));
    if (!boxOfTag(next, chosen.key) && !chosen.boxDeclined) {
      next = { ...next, findings: [...findingsOf(next), boxRow(tagByKey(next, chosen.key), boxAroundLine(line))] };
    }
    return { c: next, key: chosen.key };
  }
  const { c: withTag, tag } = addTag(c, withMeasurement("Marked area", clause), { abnormal: true });
  const next = {
    ...withTag,
    measurements: [...linesOfCase(withTag), { ...line, tagKey: tag.key, kind: "lesion", _id: tmpId() }],
    findings: [...findingsOf(withTag), boxRow(tag, boxAroundLine(line))],
  };
  return { c: next, key: tag.key };
}

// Taking away one diameter takes away the ratio sentence, which needs both.
export function removeLine(c, line) {
  const owner = tagByKey(c, line?.tagKey);
  if (owner && line.kind !== "lesion" && owner.kind === "ctr") return deleteTag(c, owner.key);
  const next = { ...c, measurements: linesOfCase(c).filter((m) => m !== line && !(line._id && m._id === line._id)) };
  return owner ? setTagText(next, owner.key, withMeasurement(owner.text, "")) : next;
}

export { linesOfTag };
