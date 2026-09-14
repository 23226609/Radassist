// scripts/test-diagnosis.mjs
import assert from "node:assert";
import { createRequire } from "node:module";
import { needsAzureDiagnosis } from "../src/lib/diagnosis.js";

const require = createRequire(import.meta.url);
const { parseDiagnosis } = require("../backend/utils/azureFindings.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

console.log("\n=== dashboard diagnosis ===");

test("trims a short clinical label", () => {
  assert.equal(parseDiagnosis("  Mild cardiomegaly.  "), "Mild cardiomegaly");
});

test("drops a second sentence and caps the length", () => {
  const long = `${"Right lower-lobe consolidation recommended for follow-up imaging and clinical correlation".repeat(2)}`;
  assert.ok(parseDiagnosis(long).length <= 80);
});

test("skips cases Azure already labelled", () => {
  assert.equal(needsAzureDiagnosis({
    diagnosis: "Mild cardiomegaly",
    diagnosisSource: "azure",
    reportText: "The heart is enlarged.",
  }), false);
});

test("upgrades the first-sentence fallback", () => {
  assert.equal(needsAzureDiagnosis({
    diagnosis: "Chest X-Ray Report",
    diagnosisSource: "local",
    reportText: "Chest X-Ray Report\n\nThe lungs are clear.",
  }), true);
});

test("leaves a short seeded diagnosis alone", () => {
  assert.equal(needsAzureDiagnosis({
    diagnosis: "Mild cardiomegaly",
    reportText: "The cardiac silhouette is mildly enlarged.",
  }), false);
});

test("fills an empty diagnosis when a report exists", () => {
  assert.equal(needsAzureDiagnosis({
    diagnosis: "",
    reportText: "The lungs are clear.",
  }), true);
});

test("skips Azure while the report is still generating", () => {
  assert.equal(needsAzureDiagnosis({
    status: "pending",
    diagnosis: "Generating report…",
    reportText: "",
  }), false);
});

// --- dashboard fills leftover first-sentence diagnoses ---
import { parseHTML } from "linkedom";

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='root'></div></body></html>"
);
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

for (const Ctor of [window.HTMLSelectElement, window.HTMLInputElement, window.HTMLOptionElement]) {
  const proto = Ctor?.prototype;
  if (proto && !Object.getOwnPropertyDescriptor(proto, "value")?.set) {
    Object.defineProperty(proto, "value", {
      configurable: true,
      get() { return this.getAttribute("value") ?? ""; },
      set(v) { this.setAttribute("value", String(v)); },
    });
  }
}

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderDashboardPage } = await import("../src/components/dashboard.js");

const leftover = {
  caseId: "CASE-DX-1",
  patientId: "PT-DX-1",
  status: "completed",
  createdAt: "2026-09-13T00:00:00.000Z",
  diagnosis: "Chest X-Ray Report",
  diagnosisSource: "local",
  reportText: "Chest X-Ray Report\n\nThe lungs are clear.",
};

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
api.listCases = async () => ({ cases: [structuredClone(leftover)] });
api.stats = async () => ({ stats: { totalCases: 1, finalizedCases: 0, pendingCases: 0 } });
let asked = null;
api.summariseDiagnosis = async (id) => {
  asked = id;
  return {
    case: {
      ...leftover,
      diagnosis: "No acute cardiopulmonary findings",
      diagnosisSource: "azure",
    },
  };
};

const root = document.getElementById("root");
await renderDashboardPage({ target: root });
await new Promise((r) => setTimeout(r, 0));

test("dashboard asks Azure to replace a leftover first-sentence diagnosis", () => {
  assert.equal(asked, "CASE-DX-1");
  assert.ok(root.textContent.includes("No acute cardiopulmonary findings"));
  assert.ok(!root.textContent.includes("Azure"), "Azure badge should stay off the dashboard");
  assert.ok(!root.textContent.includes("Connected to RadAssist backend"));
});

{
  let select = root.querySelector("select");
  select.value = "finalized";
  select.dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 0));
  select = root.querySelector("select");
  select.value = "all";
  select.dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 0));
  select = root.querySelector("select");
  test("status filter can return to All statuses", () => {
    assert.equal(select.value, "all");
  });
}

{
  let askedGen = null;
  api.listCases = async () => ({
    cases: [{
      caseId: "CASE-GEN-1",
      patientId: "PT-GEN-1",
      patientName: "Pat Gen",
      status: "pending",
      diagnosis: "Generating report…",
      createdAt: "2026-09-13T00:00:00.000Z",
    }],
  });
  api.stats = async () => ({ stats: { totalCases: 1, finalizedCases: 0, pendingCases: 0 } });
  api.summariseDiagnosis = async (id) => {
    askedGen = id;
    return { case: {} };
  };
  await renderDashboardPage({ target: root });
  await new Promise((r) => setTimeout(r, 0));
  test("dashboard shows Generating and does not ask Azure yet", () => {
    assert.ok(root.textContent.includes("Generating"));
    assert.equal(askedGen, null);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
