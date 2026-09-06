// scripts/test-e2e-case.mjs
// End-to-end smoke test: hit the running backend's `/api/cases/:id` endpoint
// for every case, then run the (real, production) AI-report pipeline
// (unwrapLegacyReport + parseFindingsFromReport) on the response.
//
// This exercises the EXACT code path the browser takes when you click "View"
// on a case in the dashboard.
//
// Usage: node scripts/test-e2e-case.mjs
//
// Prerequisites:
//   1. Backend running at http://localhost:PORT  (PORT from backend/.env)
//   2. MongoDB has been migrated (run scripts/fix-legacy-reports.js once)

const fs = await import("node:fs");
const path = await import("node:path");
import assert from "node:assert/strict";

// Load backend/.env
const envText = fs.readFileSync(
  path.join(process.cwd(), "backend", ".env"),
  "utf8"
);
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
  if (!m) continue;
  const [, key, raw] = m;
  if (process.env[key]) continue;
  let val = raw;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  process.env[key] = val;
}

const BACKEND = `http://localhost:${process.env.PORT || 5002}`;

// Login first to get a token (the /api/cases endpoints require auth).
async function login() {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "admin123",
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Login failed (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.token;
}

// Mimic the frontend api wrapper.
function api(token) {
  async function req(method, path, body) {
    const opts = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${BACKEND}${path}`, opts);
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${data?.message || data?.error || ""}`);
    }
    return data;
  }
  return {
    listCases: () => req("GET", "/api/cases"),
    getCase: (id) => req("GET", `/api/cases/${encodeURIComponent(id)}`),
  };
}

// Same logic as src/components/review.js unwrapLegacyReport.
function unwrapLegacyReport(raw) {
  if (!raw || typeof raw.reportText !== "string") return raw;
  const rt = raw.reportText.trim();
  if (!rt.startsWith("{") || !rt.includes('"report"')) return raw;
  const idx = rt.indexOf('"report":"');
  if (idx < 0) return raw;
  let val = rt.substring(idx + '"report":"'.length);
  val = val.replace(/\}\s*$/, "").trim();
  if (!val) return raw;
  try { val = JSON.parse('"' + val + '"'); } catch {}
  if (typeof val !== "string" || !val.trim()) return raw;
  return { ...raw, reportText: val };
}

// Light test harness.
let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failed++;
  }
}

console.log(`\n=== e2e (backend at ${BACKEND}) ===\n`);

let token;
try {
  token = await login();
  console.log(`Logged in. token len=${token.length}\n`);
} catch (err) {
  console.error("Could not log in — is the backend running?");
  console.error(err.message);
  process.exit(2);
}

const a = api(token);
let cases;
try {
  const list = await a.listCases();
  cases = list.cases || list.data?.cases || [];
  if (!Array.isArray(cases)) cases = [];
} catch (err) {
  console.error("listCases failed:", err.message);
  process.exit(2);
}

if (cases.length === 0) {
  console.log("Backend returned 0 cases — nothing to test.");
  process.exit(1);
}
console.log(`Found ${cases.length} cases. Testing each...\n`);

for (const c of cases) {
  const cid = c.caseId || c._id;
  if (!cid) continue;
  console.log(`\n--- ${cid}  ${c.patientId}  status=${c.status}  findings=${(c.findings||[]).length} ---`);

  await test(`${cid}: GET /api/cases/${cid} returns 200`, async () => {
    const detail = await a.getCase(cid);
    assert.ok(detail, "should return a body");
    assert.ok(detail.case || detail._id, "should have a case field or _id");
  });

  await test(`${cid}: reportText is clean (no JSON wrapper)`, async () => {
    const detail = await a.getCase(cid);
    const c2 = detail.case || detail;
    const rt = c2.reportText || "";
    // After unwrap, no leading JSON artifacts.
    const cleaned = unwrapLegacyReport(c2);
    assert.ok(!cleaned.reportText.trim().startsWith("{"), `reportText still JSON-wrapped: ${cleaned.reportText.slice(0, 40)}`);
    assert.ok(cleaned.reportText.length > 0, "reportText empty after unwrap");
    console.log(`      reportText: ${cleaned.reportText.length} chars, starts: ${JSON.stringify(cleaned.reportText.slice(0, 50))}`);
  });

  await test(`${cid}: findings is an array`, async () => {
    const detail = await a.getCase(cid);
    const c2 = detail.case || detail;
    assert.ok(Array.isArray(c2.findings), `findings not array: ${typeof c2.findings}`);
  });

  await test(`${cid}: image URL is reachable`, async () => {
    const detail = await a.getCase(cid);
    const c2 = detail.case || detail;
    if (!c2.imageId) {
      console.log(`      (no imageId — skipping)`);
      return;
    }
    const res = await fetch(`${BACKEND}/api/images/${c2.imageId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`image fetch ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.startsWith("image/"), `wrong content-type: ${ct}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
