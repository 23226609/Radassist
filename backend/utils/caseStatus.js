// Case workflow status. `completed` is the old name for pending_approve.

function publicStatus(s) {
  return s === 'completed' ? 'pending_approve' : s;
}

function toPublicCase(doc, extra = {}) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...(doc || {}) };
  o.status = publicStatus(o.status);
  if (o.imageId && o.imageUrl === undefined) {
    o.imageUrl = `/api/images/${o.imageId}`;
  }
  return { ...o, ...extra };
}

function statusFilter(status) {
  if (!status || status === 'all' || status === 'urgent') return null;
  if (status === 'pending_approve' || status === 'completed') {
    return { $in: ['pending_approve', 'completed'] };
  }
  return status;
}

module.exports = { publicStatus, toPublicCase, statusFilter };
