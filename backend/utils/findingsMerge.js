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

function mergeFindingsFromReport(previous, parsed) {
  const prev = Array.isArray(previous) ? previous : [];
  const incoming = dedupeFindings(parsed);
  const manual = prev.filter(isManualFinding);
  const accepted = prev.filter((f) => !isManualFinding(f) && f.status === 'accepted');
  const used = new Set();
  const rebuilt = incoming.map((p) => {
    const idx = accepted.findIndex((a, i) => !used.has(i) && findingsOverlap(a, p));
    if (idx < 0) return p;
    used.add(idx);
    const a = accepted[idx];
    return {
      ...p,
      status: 'accepted',
      bbox: keepManualBox(a) ? a.bbox : (p.bbox || a.bbox),
      bboxSource: keepManualBox(a) ? 'manual' : (p.bboxSource || a.bboxSource),
    };
  });
  return [...manual, ...rebuilt];
}

module.exports = { isManualFinding, mergeFindingsFromReport, dedupeFindings };
