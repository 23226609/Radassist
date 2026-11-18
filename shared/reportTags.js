// shared/reportTags.js
// The report as a list of sentence tags plus a COMMENT line.
//
//   XRAY CHEST (PA)
//   FINDINGS
//   one sentence per line
//   COMMENT
//   – one conclusive line
//   Thank you for your referral.
//
// No DOM and no imports beyond the sibling text rules, so the browser and the
// Express API split, classify and assemble a report the same way.

import {
  splitReportAndRemarks,
  normalizeReportShape,
  withoutThinking,
  thinkingBlockOf,
} from "./reportText.js";

export const THANKS_LINE = "Thank you for your referral.";

// Views the radiologist can pick. Only a PA film is read as an erect PA.
// Lateral is kept so a lateral film is not shown as "not recorded".
export const VIEWS = ["", "PA", "AP", "AP supine", "Lateral"];

export function cleanView(view) {
  const v = String(view || "").trim();
  return VIEWS.find((x) => x.toLowerCase() === v.toLowerCase()) || "";
}

export function isErectPA(view) {
  return cleanView(view) === "PA";
}

export function reportTitle(view) {
  const v = cleanView(view);
  return v ? `XRAY CHEST (${v.toUpperCase()})` : "XRAY CHEST";
}

// "Chest (PA)" for the examination name, or "Chest" when the view is unknown.
export function examinationName(view) {
  const v = cleanView(view);
  return v ? `Chest (${v})` : "Chest";
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "vs", "approx", "e.g", "i.e", "etc", "fig", "st", "ca", "cf", "c.f",
]);

function stripListMarker(line) {
  return String(line || "")
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*(?:[-–—•+]\s+|\*\s+|\d{1,2}[.)]\s+)/, "")
    .replace(/\*\*/g, "")
    .trim();
}

// Split one line of prose into sentences. A full stop only ends a sentence
// when a capital letter or digit follows the space, and not after "approx." or
// "Dr.". "10.5 : 27.5" and "2.3 cm" have no space after the dot, so they stay.
export function splitSentences(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out = [];
  let start = 0;
  const boundary = /([.!?]+)(\s+)(?=[A-Z0-9"“(\[])/g;
  let m;
  while ((m = boundary.exec(text)) !== null) {
    const end = m.index + m[1].length;
    const head = text.slice(start, end);
    const word = (head.match(/([A-Za-z.]+)\.$/) || [])[1] || "";
    const lower = word.toLowerCase();
    const initial = /(?:^|\s)[A-Z]\.$/.test(head);
    // "2." in "1. Lungs clear. 2. Heart normal." numbers the next sentence.
    const numbering = /^\d{1,2}[.)]$/.test(head.trim());
    if (numbering || (m[1] === "." && (ABBREVIATIONS.has(lower) || initial))) continue;
    out.push(head.trim());
    start = end + m[2].length;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.map(stripListMarker).filter(Boolean);
}

const BOILERPLATE = /^(?:xray chest\b|x-?ray chest\b|radiology report\b|chest x-?ray(?: report| examination)?\s*:?\s*$|patient id\b|thank you for your referral|\[ai analysis unavailable|a clinician should review the uploaded image|this report provides a comprehensive analysis)/i;

// A heading line such as "Lungs:" introduces a block; it is not a finding.
function isBlockLabel(line) {
  const raw = String(line || "").trim();
  if (!raw || /[.!?]$/.test(raw)) return false;
  return /:\s*\**\s*$/.test(raw) && stripListMarker(raw).length < 60;
}

function endsSentence(line) {
  return /[.!?]["'”)]*$/.test(String(line || "").trim());
}

// Findings text -> one sentence per entry, in order.
// A line that does not end a sentence is a wrap, so it stays with the next
// line. "No pleural" and "effusion or pneumothorax is present." are one sentence.
export function sentencesOf(text) {
  const out = [];
  let pending = "";
  const flush = () => {
    if (!pending) return;
    for (const sentence of splitSentences(pending)) {
      if (sentence.length > 1 && !BOILERPLATE.test(sentence)) out.push(sentence);
    }
    pending = "";
  };
  for (const raw of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || isBlockLabel(line)) {
      flush();
      continue;
    }
    const clean = stripListMarker(line);
    if (!clean || BOILERPLATE.test(clean)) {
      flush();
      continue;
    }
    pending = pending ? `${pending} ${clean}` : clean;
    if (endsSentence(pending)) flush();
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Normal or abnormal
// ---------------------------------------------------------------------------

// Words that name something wrong with the film. A hedge ("possible",
// "may represent", "cannot be excluded") does not make the word go away.
const ABNORMAL_WORDS = [
  "opacit\\w*", "consolidat\\w*", "effusions?", "pneumothora\\w*", "hydropneumothora\\w*", "atelecta\\w*",
  "collaps\\w*", "nodul\\w*", "masses", "mass", "lesions?", "tumou?rs?", "cardiomegaly", "enlarge\\w*",
  "widen\\w*", "oedema", "edema", "congest\\w*", "engorge\\w*", "fractur\\w*", "infiltrat\\w*",
  "pneumonia", "pneumonitis", "thicken\\w*", "fibro\\w*", "scar\\w*", "calcif\\w*", "granulom\\w*",
  "hernia", "tubes?", "catheters?", "lines?", "leads?", "pacemakers?", "stents?", "clips?", "drains?",
  "devices?", "prosthe\\w*", "implants?", "sternotomy", "wires?", "blunt\\w*", "elevat\\w*", "flatten\\w*",
  "hyperinfla\\w*", "hyperexpan\\w*", "hyperlucen\\w*", "emphysema\\w*", "bull\\w*", "bronchiectas\\w*",
  "bronchiectat\\w*", "cavit\\w*", "abscess\\w*", "tortuous", "ectatic", "aneurysm\\w*", "dilat\\w*",
  "prominen\\w*", "shift\\w*", "deviat\\w*", "displac\\w*", "obscur\\w*", "haz\\w*", "shadow\\w*",
  "densit\\w*", "dense", "volume loss", "(?:low|reduced|small|decreased|diminished) lung volumes?",
  "increased", "increase", "accentuat\\w*", "crowding", "scolio\\w*", "kyphosis", "degenerat\\w*",
  "osteopeni\\w*", "osteophyt\\w*", "deformit\\w*", "spondyl\\w*", "sclerotic", "lytic", "destruct\\w*",
  "pneumomediastinum", "pneumoperitoneum", "free air", "subcutaneous (?:air|emphysema)", "reticul\\w*",
  "air[- ]?space", "abnormal\\w*", "malposition\\w*", "retained", "residual", "post-?surgical", "fullness",
  "fluid", "lucen\\w*", "pneumatocele", "mass effect", "malignan\\w*", "metasta\\w*", "carcinoma", "cancer",
  "adenopathy", "lymphadenopathy", "worsen\\w*", "progress\\w*", "bronchogram\\w*", "healed", "kerley",
  "plaque", "overinflat\\w*", "inflammat\\w*", "infection", "infectious", "disease", "pathology",
];
const ABNORMAL_RE = new RegExp(`\\b(?:${ABNORMAL_WORDS.join("|")})\\b`, "i");

const NEGATION_RE = /\b(?:no|not|without|negative for|absence of|absent|free of|free from|nor|neither|none|never|resolved|clear of)\b|n't\b/i;

const NORMAL_RE = /\b(?:normal|unremarkable|clear|clearly|sharp|well[- ](?:expanded|aerated|inflated|defined|visuali[sz]ed|preserved|maintained|positioned|seated|circumscribed)|midline|central(?:ly)?|intact|preserved|maintained|symmetric\w*|within (?:expected|normal)|physiologic\w*|patent|satisfactory|adequate|expanded|aerated|unchanged|stable|regular|smooth|normally)\b/i;

const CONTRAST_RE = /\s+(?:but|however|although|though|whereas|while|except|yet)\s+|;/i;

const VERB_RE = /\b(?:is|are|was|were|has|have|had|shows?|showing|seen|noted|identified|visible|visuali[sz]ed|present|demonstrates?|demonstrated|appears?|appearing|remains?|extends?|measures?|measuring|represents?|reflects?|suggests?|there)\b/i;

const POSITIVE_MODIFIER_RE = /\b(?:small|mild|mildly|moderate|moderately|large|tiny|trace|new|worsening|minimal|severe|slight|subtle|prominent|marked|extensive)\b/i;

const HEDGED_EXCLUSION_RE = /\b(?:cannot|can't|can not|could not|couldn't|unable to)\s+(?:be\s+)?(?:totally\s+|entirely\s+|completely\s+|definitely\s+|fully\s+)?(?:exclude[d]?|rule[d]?\s+out)\b|\b(?:not|isn't|aren't)\s+(?:been\s+)?(?:excluded|ruled out)\b/i;

// "No change in the right lower lobe opacity" is a comparison, not a denial of
// the opacity. Turn it into "unchanged" so the opacity still counts.
function withoutComparisonNegation(s) {
  return s.replace(/\bno\s+(?:significant\s+|interval\s+|appreciable\s+|substantial\s+|obvious\s+|definite\s+)*change\b/g, "unchanged");
}

function chunksOf(sentence) {
  const chunks = [];
  for (const part of sentence.split(CONTRAST_RE)) {
    const pieces = part.split(/\s*,\s*|\s+(?:or|nor)\s+(?=\w+(?:\s+\w+){0,3}\s*$)/);
    pieces.forEach((piece, i) => chunks.push({ text: piece.trim(), first: i === 0 }));
  }
  return chunks.filter((c) => c.text);
}

// The part of a sentence that names an abnormality nobody has denied.
function namesUndeniedAbnormality(sentence) {
  let inherited = false;
  for (const { text, first } of chunksOf(sentence)) {
    if (first) inherited = false;
    const cue = NEGATION_RE.exec(text);
    const own = cue ? text.slice(cue.index) : "";
    const before = cue ? text.slice(0, cue.index) : text;
    if (cue) {
      // "effusion has resolved" denies the whole clause, "without edema" only what follows.
      if (!/^resolved$/i.test(cue[0]) && ABNORMAL_RE.test(before)) return true;
      inherited = true;
      continue;
    }
    if (!ABNORMAL_RE.test(own || text)) continue;
    // "No effusion or pneumothorax is present" is one denial. "is present"
    // does not start a new claim after "or".
    const presenceTail = /^(?:[a-z0-9'-]+\s+){0,6}(?:is|are|was|were)\s+present\b/i.test(text);
    const continues = inherited && ((!VERB_RE.test(text) && !POSITIVE_MODIFIER_RE.test(text)) || presenceTail);
    if (continues) continue;
    inherited = false;
    return true;
  }
  return false;
}

// Normal = the sentence only states a negative or a normal appearance.
// Anything that names an abnormality, hedged or not, is abnormal. A sentence
// that says nothing either way is treated as abnormal: a box that is not
// needed is visible and can be switched off, a missing box is not.
export function isNormalSentence(text) {
  const s = withoutComparisonNegation(
    String(text || "").toLowerCase().replace(/[“”"]/g, "").replace(/\s+/g, " ").trim()
  );
  if (!s) return true;
  if (HEDGED_EXCLUSION_RE.test(s) && ABNORMAL_RE.test(s)) return false;
  if (namesUndeniedAbnormality(s)) return false;
  return NEGATION_RE.test(s) || NORMAL_RE.test(s);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function nextTagKey(tags) {
  let max = 0;
  for (const t of Array.isArray(tags) ? tags : []) {
    const n = Number(String(t?.key || "").replace(/^t/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t${max + 1}`;
}

export function makeTag(text, tags = [], extra = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return {
    key: nextTagKey(tags),
    text: clean,
    abnormal: !isNormalSentence(clean),
    manual: false,
    kind: "",
    ...extra,
  };
}

export function tagsFromText(findingsText) {
  const tags = [];
  for (const sentence of sentencesOf(findingsText)) tags.push(makeTag(sentence, tags));
  return tags;
}

// ---------------------------------------------------------------------------
// The stored report text
// ---------------------------------------------------------------------------

const SECTION_HEAD = /^(?:#+\s*)?\**(findings|imaging findings|description of findings|impression|conclusion|comment)\**\s*(?::\s*(.*))?$/i;

function commentFromLines(lines) {
  return lines
    .map((l) => stripListMarker(l))
    .filter((l) => l && !BOILERPLATE.test(l))
    .join("\n");
}

// Findings, Impression (-> COMMENT), Thinking and remarks of any stored report:
// CURV's Findings / Thinking / Impression, the free-form shape, the assembled
// layout above, or plain prose.
export function parseReportSections(reportText) {
  const split = splitReportAndRemarks(reportText);
  const thinking = thinkingBlockOf(split.body);
  const body = normalizeReportShape(withoutThinking(split.body));
  const findings = [];
  const impression = [];
  const pre = [];
  let current = "pre";
  let sawFindingsHead = false;
  for (const raw of body.split("\n")) {
    const head = SECTION_HEAD.exec(raw.trim());
    if (head) {
      const name = head[1].toLowerCase();
      current = /findings/.test(name) ? "findings" : "impression";
      if (current === "findings") sawFindingsHead = true;
      if (head[2]) (current === "findings" ? findings : impression).push(head[2]);
      continue;
    }
    if (current === "findings") findings.push(raw);
    else if (current === "impression") impression.push(raw);
    else pre.push(raw);
  }
  // Prose with no heading, or an Impression with no Findings heading before it.
  if (!sawFindingsHead) findings.unshift(...pre);
  return {
    findings: findings.join("\n").trim(),
    impression: commentFromLines(impression),
    thinking,
    remarks: split.remarks,
  };
}

export function commentLines(comment) {
  return String(comment || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => stripListMarker(l))
    .filter(Boolean);
}

// Findings sentences and COMMENT for a stored report.
export function deriveFromReport(reportText) {
  const parts = parseReportSections(reportText);
  return {
    findingTags: tagsFromText(parts.findings),
    comment: parts.impression,
    thinking: parts.thinking,
  };
}

// The text every reader gets: the referring doctor, the share link, Word and
// PDF. Thinking, when there is one, is carried at the end and never shown.
export function assembleReport({ view = "", tags = [], comment = "", thinking = "" } = {}) {
  const lines = [reportTitle(view), "", "FINDINGS"];
  for (const t of Array.isArray(tags) ? tags : []) {
    const sentence = String(t?.text || "").replace(/\s+/g, " ").trim();
    if (sentence) lines.push(sentence);
  }
  lines.push("", "COMMENT");
  for (const line of commentLines(comment)) lines.push(`– ${line}`);
  lines.push("", THANKS_LINE);
  const body = lines.join("\n");
  const thought = String(thinking || "").trim();
  return thought ? `${body}\n\n${thought}` : body;
}

// ---------------------------------------------------------------------------
// Older cases that only have reportText
// ---------------------------------------------------------------------------

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function hasBbox(f) {
  return Array.isArray(f?.bbox) && f.bbox.length === 4 && Number(f.bbox[2]) > 0 && Number(f.bbox[3]) > 0;
}

function isDrawn(f) {
  return String(f?.source || "").toLowerCase() === "manual";
}

function deniesFinding(f) {
  const text = `${f?.label || ""} ${f?.sentence || ""}`.replace(/\s+/g, " ").trim();
  return text ? isNormalSentence(text) : false;
}

// A box the old review page would have drawn on the film.
function wasDrawn(f) {
  if (!hasBbox(f) || f.status === "rejected") return false;
  if (isDrawn(f)) return true;
  if (deniesFinding(f)) return false;
  if (f.source) return f.source === "Azure" && f.severity !== "normal";
  return Boolean(f.bboxSource) && f.severity !== "normal";
}

function sameWords(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return (x.length >= 8 && y.includes(x)) || (y.length >= 8 && x.includes(y));
}

function matchesTag(box, tag) {
  return sameWords(box.sentence, tag.text) || sameWords(box.label, tag.text);
}

// Split an older case once: one tag per sentence, COMMENT from the Impression,
// and each box or line it already has linked to its sentence. Returns the case
// unchanged when it already has tags or has nothing to split.
export function ensureTags(c) {
  if (!c || (Array.isArray(c.findingTags) && c.findingTags.length)) return c;
  if (!String(c.reportText || "").trim()) return c;
  const parsed = deriveFromReport(c.reportText);
  if (!parsed.findingTags.length && (c.comment || !parsed.comment)) return c;

  const tags = parsed.findingTags.map((t) => ({ ...t }));
  const used = new Set();
  const findings = (Array.isArray(c.findings) ? c.findings : []).map((f) => {
    const box = f && typeof f.toObject === "function" ? f.toObject() : { ...f };
    if (box.tagKey) return box;
    const idx = tags.findIndex((t, i) => !used.has(i) && matchesTag(box, t));
    if (idx >= 0 && (wasDrawn(box) || box.status === "rejected")) {
      used.add(idx);
      box.tagKey = tags[idx].key;
      if (box.status === "rejected") tags[idx].boxDeclined = true;
      else tags[idx].abnormal = true;
    }
    return box;
  });
  for (const box of findings) {
    if (box.tagKey || !wasDrawn(box) || !isDrawn(box)) continue;
    const tag = makeTag(box.label || "Marked area", tags, { abnormal: true });
    tags.push(tag);
    box.tagKey = tag.key;
  }
  const measurements = (Array.isArray(c.measurements) ? c.measurements : []).map((m) => {
    const line = m && typeof m.toObject === "function" ? m.toObject() : { ...m };
    if (line.tagKey) return line;
    const tag = makeTag(line.label || "Measured area", tags, { abnormal: true });
    tags.push(tag);
    line.tagKey = tag.key;
    return line;
  });
  return {
    ...c,
    findingTags: tags,
    comment: c.comment || parsed.comment,
    findings,
    measurements,
    tagsDerived: true,
  };
}
