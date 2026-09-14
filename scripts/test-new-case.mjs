// scripts/test-new-case.mjs
//
// Renders the new-case page and checks that the Upload X-Ray box accepts
// a dragged file as well as a picked one.
//
//   node scripts/test-new-case.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='root'></div></body></html>"
);

globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.URL = URL;
globalThis.URL.createObjectURL = () => "blob:test-xray";
globalThis.URL.revokeObjectURL = () => {};
try {
  window.location.href = "http://localhost:5173/";
} catch {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost:5173/"),
  });
}

const selectProto = window.HTMLSelectElement?.prototype;
if (selectProto && !Object.getOwnPropertyDescriptor(selectProto, "value")?.set) {
  Object.defineProperty(selectProto, "value", {
    configurable: true,
    get() {
      return this.getAttribute("value") ?? "";
    },
    set(v) {
      this.setAttribute("value", String(v));
    },
  });
}

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderNewCasePage } = await import("../src/components/newCase.js");

api.listPatients = async () => ({ patients: [] });
api.listCases = async () => ({ cases: [] });

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

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
state.selectedFile = null;

const root = document.getElementById("root");
await renderNewCasePage({ target: root });

const dropZone = () => root.querySelector("#xray-drop") || root.querySelector('[data-drop="xray"]');

console.log("\n=== new case upload ===");

test("asks for first and last name", () => {
  assert.ok([...root.querySelectorAll("input")].some((i) => i.getAttribute("placeholder") === "First name"));
  assert.ok([...root.querySelectorAll("input")].some((i) => i.getAttribute("placeholder") === "Middle name (optional)"));
  assert.ok([...root.querySelectorAll("input")].some((i) => i.getAttribute("placeholder") === "Last name"));
});

test("shows an Upload X-Ray drop zone", () => {
  assert.ok(root.textContent.includes("2. Upload X-Ray"));
  const zone = dropZone();
  assert.ok(zone, "drop zone missing");
  assert.ok(zone.tagName === "LABEL" || zone.querySelector("input[type=file]"), "file picker missing");
  assert.ok(/drag/i.test(zone.textContent), `drop hint missing in: ${zone.textContent}`);
});

{
  const file = new File(["xray-bytes"], "chest.png", { type: "image/png" });
  const ev = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    configurable: true,
    value: { files: [file], dropEffect: "copy" },
  });
  dropZone().dispatchEvent(ev);
}

test("dropping an image onto the box selects that file", () => {
  assert.equal(state.selectedFile?.name, "chest.png");
  assert.ok(root.textContent.includes("chest.png"), "filename not shown after drop");
  assert.ok(root.querySelector("img"), "preview missing after drop");
});

{
  const ev = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    configurable: true,
    value: { files: [new File(["nope"], "notes.txt", { type: "text/plain" })] },
  });
  dropZone().dispatchEvent(ev);
}

test("dropping a non-image leaves the current X-ray in place", () => {
  assert.equal(state.selectedFile?.name, "chest.png");
  assert.ok(root.textContent.includes("chest.png"));
});

test("submit button is Upload X-Ray", () => {
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Upload X-Ray"));
});

{
  api.createCase = async () => ({
    analysing: true,
    case: {
      caseId: "CASE-NEW-1",
      patientId: "PT-1",
      patientName: "Ada Wong",
      firstName: "Ada",
      lastName: "Wong",
      status: "pending",
      diagnosis: "Generating report…",
    },
  });
  api.getCase = async () => ({
    case: { caseId: "CASE-NEW-1", status: "pending", diagnosis: "Generating report…" },
  });

  function fill(node, value) {
    node.value = value;
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  fill([...root.querySelectorAll("input")].find((i) => /Patient ID/.test(i.getAttribute("placeholder") || "")), "PT-1");
  fill(root.querySelector("#patient-first-name"), "Ada");
  fill(root.querySelector("#patient-last-name"), "Wong");
  fill(root.querySelector("#case-age"), "40");
  root.querySelector('[data-sex="Female"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Upload X-Ray")
    .dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
}

test("upload returns to the worklist with a generating overlay", () => {
  assert.equal(state.page, "dashboard");
  const overlay = document.getElementById("radassist-analysis");
  assert.ok(overlay, "overlay missing");
  assert.equal(overlay.hidden, false);
  assert.ok(overlay.textContent.includes("Generating the report"));
});

const { stopAnalysisWatch } = await import("../src/lib/analysisJob.js");
stopAnalysisWatch();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
