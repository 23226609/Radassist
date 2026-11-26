// Role helpers. `nurse` is treated as technician for leftover demo accounts.

const ROLES = ['technician', 'radiologist', 'doctor', 'admin', 'patient'];

function normalizeRole(role) {
  if (role === 'nurse') return 'technician';
  return role || '';
}

function isAdmin(user) {
  return normalizeRole(user?.role) === 'admin';
}

function canUpload(user) {
  const r = normalizeRole(user?.role);
  return r === 'technician' || r === 'admin';
}

function canEditPatient(user) {
  const r = normalizeRole(user?.role);
  return r === 'technician' || r === 'radiologist' || r === 'admin';
}

function canEditReport(user) {
  const r = normalizeRole(user?.role);
  return r === 'radiologist' || r === 'admin';
}

function isReferringDoctor(user) {
  return normalizeRole(user?.role) === 'doctor';
}

function isPatient(user) {
  return normalizeRole(user?.role) === 'patient';
}

function isTechnician(user) {
  return normalizeRole(user?.role) === 'technician';
}

module.exports = {
  ROLES,
  normalizeRole,
  isAdmin,
  canUpload,
  canEditPatient,
  canEditReport,
  isReferringDoctor,
  isTechnician,
  isPatient,
};
