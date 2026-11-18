// Keep clinician-added cards, replace machine cards, and preserve Accepted
// when the new Azure/local list still describes the same finding.

function isManualFinding(f) {
  const source = String(f?.source || '').toLowerCase();
  if (source === 'manual' || source === 'clinician') return true;
  return String(f?._id || f?.id || '').startsWith('tmp-');
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findingsOverlap(a, b) {
  const al = norm(a?.label);
  const bl = norm(b?.label);
  const as = norm(a?.sentence);
  const bs = norm(b?.sentence);
  if (al && bl && (al === bl || (al.length >= 8 && bl.includes(al)) || (bl.length >= 8 && al.includes(bl)))) {
    return true;
  }
  if (as && bs && as.length >= 12 && bs.length >= 12 && (as.includes(bs) || bs.includes(as))) {
    return true;
  }
  if (al && bs && al.length >= 8 && bs.includes(al)) return true;
  if (bl && as && bl.length >= 8 && as.includes(bl)) return true;
  return false;
}

function keepManualBox(prev) {
  return prev?.bboxSource === 'manual'
    && Array.isArray(prev?.bbox)
    && prev.bbox.length === 4;
}

function isNegativeFinding(f) {
  const t = `${f?.label || ''} ${f?.sentence || ''}`.toLowerCase();
  if (/\b(white-?out|opacif|consolidat|atelecta|effusion|pneumothorax|fracture|mass|nodule|pneumonia)\b/.test(t)) {
    return false;
  }
  return /\b(clear|normal|unremarkable|no (?:evidence|signs?) of|within normal limits)\b/.test(t);
}

function isWhiteoutFinding(f) {
  return /\b(white-?out|opaque hemithorax|hemithorax opacif|complete opacif)/i.test(
    `${f?.label || ''} ${f?.sentence || ''}`
  );
}

function dedupeFindings(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (out.some((p) => findingsOverlap(p, f))) continue;
    out.push(f);
  }
  if (out.some(isWhiteoutFinding)) {
    return out.filter((f) => isWhiteoutFinding(f) || !isNegativeFinding(f));
  }
  return out;
}

// Radiologist work survives a fresh Azure pass: drawn boxes are kept, a
// resized AI box keeps its size, and a deleted (rejected) AI box stays deleted.
function mergeFindingsFromReport(previous, parsed) {
  const prev = Array.isArray(previous) ? previous : [];
  const incoming = dedupeFindings(parsed);
  const manual = prev.filter(isManualFinding);
  const reviewed = prev.filter((f) => !isManualFinding(f)
    && (f.status === 'accepted' || f.status === 'rejected' || keepManualBox(f)));
  const used = new Set();
  const rebuilt = incoming.map((p) => {
    const idx = reviewed.findIndex((a, i) => !used.has(i) && findingsOverlap(a, p));
    if (idx < 0) return p;
    used.add(idx);
    const a = reviewed[idx];
    return {
      ...p,
      status: a.status || p.status,
      bbox: keepManualBox(a) ? a.bbox : (p.bbox || a.bbox),
      bboxSource: keepManualBox(a) ? 'manual' : (p.bboxSource || a.bboxSource),
    };
  });
  return [...manual, ...rebuilt];
}

const hasBox = (f) => Array.isArray(f?.bbox) && f.bbox.length === 4;

// The radiologist drew, moved or accepted this box; a fresh pass leaves it alone.
function isUserBox(f) {
  return keepManualBox(f) || f?.status === 'accepted' || isManualFinding(f);
}

// Boxes by sentence tag: one box per abnormal tag.
//  - a tag the radiologist took the box from (rejected) stays without one
//  - a box the radiologist drew, moved or accepted is kept
//  - a machine box is replaced by the new pass, when the tag is abnormal
//  - a normal tag never gains a box, and a machine box on it is dropped
//  - a box whose tag was deleted is dropped
//  - boxes with no tag (older cases, hand-added cards) are kept as they are
function mergeTagBoxes(previous, tags, incoming) {
  const prev = (Array.isArray(previous) ? previous : []).map((f) => (f && typeof f.toObject === 'function' ? f.toObject() : f));
  const list = Array.isArray(tags) ? tags : [];
  const known = new Map(list.map((t) => [t.key, t]));
  const fresh = new Map();
  for (const f of Array.isArray(incoming) ? incoming : []) {
    if (f?.tagKey && !fresh.has(f.tagKey)) fresh.set(f.tagKey, f);
  }

  const out = [];
  for (const f of prev) {
    if (!f?.tagKey) {
      out.push(f);
      continue;
    }
    const tag = known.get(f.tagKey);
    if (!tag) continue;
    if (f.status === 'rejected') {
      out.push(f);
      continue;
    }
    if (isUserBox(f)) {
      out.push(f);
      continue;
    }
    if (!tag.abnormal) continue;
    // A machine box stays unless a fresh one replaces it below.
    if (!fresh.has(f.tagKey)) out.push(f);
  }
  for (const tag of list) {
    if (!tag.abnormal || tag.boxDeclined || tag.kind === 'ctr') continue;
    const row = fresh.get(tag.key);
    if (!row || !hasBox(row)) continue;
    const held = out.some((f) => f.tagKey === tag.key);
    const machineHeld = prev.some((f) => f.tagKey === tag.key && !isUserBox(f) && f.status !== 'rejected');
    const rejected = prev.some((f) => f.tagKey === tag.key && f.status === 'rejected');
    if (rejected || (held && !machineHeld)) continue;
    out.push(row);
  }
  return out;
}

module.exports = { isManualFinding, mergeFindingsFromReport, dedupeFindings, mergeTagBoxes, isUserBox };
