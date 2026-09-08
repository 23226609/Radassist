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

async function request(method, path, body, { raw, headers } = {}) {
  const opts = {
    method,
    headers: {
      Accept: "application/json",
      ...(headers || {}),
    },
  };
  const t = token();
  if (t) opts.headers.Authorization = `Bearer ${t}`;

  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, opts);

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
  listCases: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/cases${q ? "?" + q : ""}`);
  },
  getCase: (id) => request("GET", `/cases/${encodeURIComponent(id)}`),
  createCase: (formData) =>
    request("POST", "/cases", formData, { headers: {} }), // FormData keeps its own Content-Type
  updateCase: (id, payload) => request("PUT", `/cases/${encodeURIComponent(id)}`, payload),
  finalizeCase: (id) => request("POST", `/cases/${encodeURIComponent(id)}/finalize`),
  summariseFindings: (id) =>
    request("POST", `/cases/${encodeURIComponent(id)}/summarise-findings`),
  deleteCase: (id) => request("DELETE", `/cases/${encodeURIComponent(id)}`),
  imageUrl: (imageId) => `${BASE}/images/${imageId}`,
  fetchImage: async (imageId) => {
    const res = await request("GET", `/images/${imageId}`, undefined, { raw: true });
    if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
    return res.blob();
  },

  // Users
  listUsers: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/users${q ? "?" + q : ""}`);
  },

  // Audit
  listAudit: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/audit-logs${q ? "?" + q : ""}`);
  },

  // Stats
  stats: () => request("GET", "/stats"),
};
