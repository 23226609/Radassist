// Role helpers. `nurse` is treated as technician for leftover demo accounts.

export function roleOf(user) {
  const r = typeof user === "string" ? user : user?.role;
  if (r === "nurse") return "technician";
  return r || "";
}

export function isAdmin(user) {
  return roleOf(user) === "admin";
}

export function isTechnician(user) {
  return roleOf(user) === "technician";
}

export function isReferringDoctor(user) {
  return roleOf(user) === "doctor";
}

export function canUpload(user) {
  const r = roleOf(user);
  return r === "technician" || r === "admin";
}

export function canEditPatient(user) {
  const r = roleOf(user);
  return r === "technician" || r === "radiologist" || r === "admin";
}

export function canEditReport(user) {
  const r = roleOf(user);
  return r === "radiologist" || r === "admin";
}

export function canRunAi(user) {
  return canEditReport(user);
}

export function canSeeAudit(user) {
  return canEditReport(user);
}

export function canSeeDrafts(user) {
  return !isReferringDoctor(user);
}

export function canExport(user) {
  return canEditReport(user) || isReferringDoctor(user);
}
