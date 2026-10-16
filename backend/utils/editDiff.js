// What changed between two saved drafts, for the review-page draft log.

function linesOf(text) {
  return String(text || '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function reportBody(text) {
  return String(text || '').split(/\n\s*Radiologist remarks\s*\n/i)[0];
}

function clip(text) {
  const value = String(text || '').trim();
  return value.length > 400 ? `${value.slice(0, 397)}…` : value;
}

function findingBrief(finding = {}) {
  const parts = [finding.label, finding.location, finding.size, finding.pattern, finding.sentence]
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  if (Array.isArray(finding.bbox) && finding.bbox.length === 4) {
    parts.push(`box ${finding.bbox.map((n) => Math.round(Number(n) || 0)).join(',')}`);
  }
  if (finding.status === 'rejected') parts.push('box deleted');
  return parts.join(' · ');
}

function textChanges(before, after, label) {
  const oldLines = linesOf(before);
  const newLines = linesOf(after);
  const changes = [];
  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      changes.push({ action: 'removed', field: label, label, before: clip(line), after: '' });
    }
  }
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      changes.push({ action: 'added', field: label, label, before: '', after: clip(line) });
    }
  }
  return changes;
}

function findingChanges(prev = [], next = []) {
  const changes = [];
  const nextById = new Map(next.filter((row) => row && row._id).map((row) => [String(row._id), row]));
  const prevById = new Map(prev.filter((row) => row && row._id).map((row) => [String(row._id), row]));
  const matchedNext = new Set();
  for (const row of prev) {
    const id = row && row._id ? String(row._id) : '';
    const match = id ? nextById.get(id) : null;
    if (id && match) {
      matchedNext.add(id);
      const before = findingBrief(row);
      const after = findingBrief(match);
      if (before !== after) {
        changes.push({
          action: 'edited',
          field: 'finding',
          label: match.label || row.label || 'Finding',
          before: clip(before),
          after: clip(after),
        });
      }
      continue;
    }
    changes.push({
      action: 'removed',
      field: 'finding',
      label: row.label || 'Finding',
      before: clip(findingBrief(row)),
      after: '',
    });
  }
  for (const row of next) {
    const id = row && row._id ? String(row._id) : '';
    if (id && (matchedNext.has(id) || prevById.has(id))) continue;
    changes.push({
      action: 'added',
      field: 'finding',
      label: row.label || 'Finding',
      before: '',
      after: clip(findingBrief(row)),
    });
  }
  return changes;
}

function remarkChange(before, after) {
  const prev = String(before || '').trim();
  const next = String(after || '').trim();
  if (prev === next) return [];
  if (!prev) return [{ action: 'added', field: 'remarks', label: 'Remarks', before: '', after: clip(next) }];
  if (!next) return [{ action: 'removed', field: 'remarks', label: 'Remarks', before: clip(prev), after: '' }];
  return [{ action: 'edited', field: 'remarks', label: 'Remarks', before: clip(prev), after: clip(next) }];
}

function measurementBrief(m = {}) {
  const label = String(m.label || '').trim();
  const text = String(m.text || '').trim();
  return [label, text].filter(Boolean).join(': ') || 'Measurement';
}

function measurementKey(m = {}) {
  return ['x1', 'y1', 'x2', 'y2'].map((k) => Math.round((Number(m[k]) || 0) * 10)).join(',');
}

function measurementChanges(prev = [], next = []) {
  const before = new Map(prev.map((m) => [measurementKey(m), m]));
  const after = new Map(next.map((m) => [measurementKey(m), m]));
  const changes = [];
  for (const [key, m] of before) {
    const match = after.get(key);
    if (!match) {
      changes.push({ action: 'removed', field: 'measurement', label: 'Measurement', before: clip(measurementBrief(m)), after: '' });
    } else if (measurementBrief(m) !== measurementBrief(match)) {
      changes.push({ action: 'edited', field: 'measurement', label: 'Measurement', before: clip(measurementBrief(m)), after: clip(measurementBrief(match)) });
    }
  }
  for (const [key, m] of after) {
    if (!before.has(key)) {
      changes.push({ action: 'added', field: 'measurement', label: 'Measurement', before: '', after: clip(measurementBrief(m)) });
    }
  }
  return changes;
}

function summarize(changes) {
  const count = (action) => changes.filter((row) => row.action === action).length;
  const parts = [];
  if (count('added')) parts.push(`added ${count('added')}`);
  if (count('removed')) parts.push(`removed ${count('removed')}`);
  if (count('edited')) parts.push(`edited ${count('edited')}`);
  return parts.length ? `Radiologist ${parts.join(', ')}.` : 'Radiologist saved the report.';
}

function buildEditChanges(prev = {}, next = {}) {
  const changes = [
    ...textChanges(reportBody(prev.reportText), reportBody(next.reportText), 'Report'),
    ...findingChanges(prev.findings || [], next.findings || []),
    ...remarkChange(prev.remarks, next.remarks),
    ...measurementChanges(prev.measurements || [], next.measurements || []),
  ].slice(0, 30);
  return { summary: summarize(changes), changes };
}

module.exports = { buildEditChanges };
