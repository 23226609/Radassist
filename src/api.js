// src/api.js
// Tiny fetch wrapper that:
//  - prepends /api
//  - attaches Bearer token when present
//  - JSON-parses responses and throws { status, message } on non-2xx

const BASE = "/api";

function token() {
  try { return JSON.parse(localStorage.getItem("radassist.auth") || "{}").token || ""; }
  catch { return ""; }
}

export function setSession(session) {
  // session = { token, user }  or null to clear
  if (!session) {
    localStorage.removeItem("radassist.auth");
  } else {
    localStorage.setItem("radassist.auth", JSON.stringify(session));
  }
}

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem("radassist.auth") || "null");
  } catch { return null; }
}

const missingCaseIds = new Map();
const MISSING_CASE_MS = 60_000;

function rememberMissingCase(id) {
  const sid = String(id || "").trim();
  if (sid) missingCaseIds.set(sid, Date.now() + MISSING_CASE_MS);
}

function isMissingCase(id) {
  const sid = String(id || "").trim();
  const until = missingCaseIds.get(sid);
  if (!until) return false;
  if (Date.now() > until) {
    missingCaseIds.delete(sid);
    return false;
  }
  return true;
}

function missingCaseError(id) {
  const err = new Error(`Case ${id} not found`);
  err.status = 404;
  return err;
}

async function request(method, path, body, { raw, headers, signal } = {}) {
  const opts = {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(headers || {}),
    },
  };
  if (signal) opts.signal = signal;
  const t = token();
  if (t) opts.headers.Authorization = `Bearer ${t}`;

  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const e = new Error("Backend unreachable");
    e.status = 0;
    throw e;
  }

  if (raw) return res;

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const message = data?.error || data?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // Auth
  login: (username, password) => request("POST", "/auth/login", { username, password }),
  register: (payload) => request("POST", "/auth/register", payload),
  me: () => request("GET", "/auth/me"),
  logout: () => request("POST", "/auth/logout"),

  // Cases
  listCases: (params = {}, opts = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/cases${q ? "?" + q : ""}`, undefined, opts);
  },
  getCase: async (id, opts = {}) => {
    const sid = String(id || "").trim();
    if (!sid) throw missingCaseError(id);
    if (isMissingCase(sid)) throw missingCaseError(sid);
    try {
      return await request("GET", `/cases/${encodeURIComponent(sid)}`, undefined, opts);
    } catch (err) {
      if (err?.status === 404) rememberMissingCase(sid);
      throw err;
    }
  },
  createCase: (formData) =>
    request("POST", "/cases", formData, { headers: {} }), // FormData keeps its own Content-Type
  updateCase: (id, payload) => request("PUT", `/cases/${encodeURIComponent(id)}`, payload),
  analyzeCase: (id) => request("POST", `/cases/${encodeURIComponent(id)}/analyze`),
  finalizeCase: (id) => request("POST", `/cases/${encodeURIComponent(id)}/finalize`),
  summariseFindings: (id) =>
    request("POST", `/cases/${encodeURIComponent(id)}/summarise-findings`),
  summariseDiagnosis: (id) =>
    request("POST", `/cases/${encodeURIComponent(id)}/summarise-diagnosis`),
  shareCase: (id) => request("POST", `/cases/${encodeURIComponent(id)}/share`),
  unshareCase: (id) => request("DELETE", `/cases/${encodeURIComponent(id)}/share`),
  getSharedCase: (token) => request("GET", `/share/${encodeURIComponent(token)}`),
  sharedImageUrl: (token) => `${BASE}/share/${encodeURIComponent(token)}/image`,
  deleteCase: (id) => request("DELETE", `/cases/${encodeURIComponent(id)}`),
  deleteCases: (ids) => request("POST", "/cases/bulk-delete", { ids }),
  imageUrl: (imageId) => `${BASE}/images/${imageId}`,
  fetchImage: async (imageId) => {
    const res = await request("GET", `/images/${imageId}`, undefined, { raw: true });
    if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
    return res.blob();
  },

  // Patients
  listPatients: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/patients${q ? "?" + q : ""}`);
  },
  createPatient: (payload) => request("POST", "/patients", payload),
  getPatient: (id) => request("GET", `/patients/${encodeURIComponent(id)}`),
  updatePatient: (id, payload) => request("PUT", `/patients/${encodeURIComponent(id)}`, payload),
  deletePatient: (id) => request("DELETE", `/patients/${encodeURIComponent(id)}`),
  deletePatients: (ids) => request("POST", "/patients/bulk-delete", { ids }),

  // Users
  listUsers: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/users${q ? "?" + q : ""}`);
  },
  setUserActive: (id, isActive) =>
    request("PUT", `/users/${encodeURIComponent(id)}/active`, { isActive }),

  // Audit
  listAudit: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/audit-logs${q ? "?" + q : ""}`);
  },
  deleteAudit: (id) => request("DELETE", `/audit-logs/${encodeURIComponent(id)}`),
  deleteAuditLogs: (ids) => request("POST", "/audit-logs/bulk-delete", { ids }),

  // Stats
  stats: (opts = {}) => request("GET", "/stats", undefined, opts),
};
