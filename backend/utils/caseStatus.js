// Case workflow status. `completed` is the old name for pending_approve.

function publicStatus(s) {
  return s === 'completed' ? 'pending_approve' : s;
}

function analysisStateOf(doc = {}) {
  if (doc.analysisState === 'none' || doc.analysisState === 'running' || doc.analysisState === 'done') {
    return doc.analysisState;
  }
  if (publicStatus(doc.status) === 'pending') {
    if (/generating report/i.test(String(doc.diagnosis || ''))) return 'running';
    if (!String(doc.reportText || '').trim()) return 'none';
  }
  return 'done';
}

function toPublicCase(doc, extra = {}) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...(doc || {}) };
  o.status = publicStatus(o.status);
  o.analysisState = analysisStateOf(o);
  if (o.imageId && o.imageUrl === undefined) {
    o.imageUrl = `/api/images/${o.imageId}`;
  }
  const token = o.shareToken || '';
  delete o.shareToken;
  o.shared = Boolean(token);
  if (extra.includeShareToken && token) o.shareToken = token;
  if (!extra.includeEditLog) delete o.editLog;
  if (extra.hideFilm) {
    delete o.imageId;
    delete o.imageUrl;
    o.reportText = '';
    o.findings = [];
  }
  if (extra.stripProvenance) {
    o.findings = (o.findings || []).map((f) => {
      const row = f && typeof f.toObject === 'function' ? f.toObject() : { ...f };
      delete row.source;
      return row;
    });
  }
  const { includeShareToken, includeEditLog, stripProvenance, hideFilm, ...rest } = extra;
  return { ...o, ...rest };
}

function statusFilter(status) {
  if (!status || status === 'all' || status === 'urgent') return null;
  if (status === 'pending_approve' || status === 'completed') {
    return { $in: ['pending_approve', 'completed'] };
  }
  return status;
}

module.exports = { publicStatus, analysisStateOf, toPublicCase, statusFilter };
