// scripts/test-audit-page.mjs
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
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
window.confirm = () => true;

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
const { renderAuditPage } = await import("../src/components/audit.js");

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

console.log("\n=== audit log ===");

const logs = [
  {
    logId: "LOG-1",
    timestamp: "2026-09-01T00:00:00.000Z",
    userId: "USR-ADMIN-0001",
    action: "LOGIN",
    details: "Seed admin logged in",
    affectedCaseId: "",
  },
  {
    logId: "LOG-2",
    timestamp: "2026-09-01T01:00:00.000Z",
    userId: "USR-DOC-0001",
    action: "CASE_CREATED",
    details: "Created case CASE-1",
    affectedCaseId: "CASE-1",
  },
];

api.listAudit = async () => ({ logs: structuredClone(logs) });
let deleted = null;
api.deleteAuditLogs = async (ids) => { deleted = ids; return { success: true, deleted: ids.length }; };

const root = document.getElementById("root");
state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
await renderAuditPage({ target: root });

test("doctors can read the audit log but cannot delete entries", () => {
  assert.ok(root.textContent.includes("Seed admin logged in"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => /Delete/.test(b.textContent)));
  assert.equal(root.querySelectorAll('input[type="checkbox"]').length, 0);
});

state.user = { role: "admin", userId: "a1", name: "System Admin" };
await renderAuditPage({ target: root });

test("admins tick rows and use one Delete button", () => {
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"));
  assert.equal(root.querySelectorAll('input[type="checkbox"][aria-label="Select row"]').length, 2);
});

for (let i = 0; i < 2; i++) {
  const boxes = [...root.querySelectorAll('input[type="checkbox"][aria-label="Select row"]')];
  boxes[i].checked = true;
  boxes[i].dispatchEvent(new window.Event("change"));
}
const del = [...root.querySelectorAll("button")].find((b) => /Delete/.test(b.textContent));
test("the Delete button shows how many rows are selected", () => {
  assert.ok(del && del.textContent.includes("2"), `expected Delete (2), got ${del?.textContent}`);
});
del.dispatchEvent(new window.Event("click"));
await new Promise((r) => setTimeout(r, 0));

test("admin bulk delete on the audit log sends every selected id", () => {
  assert.deepEqual(deleted, ["LOG-1", "LOG-2"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
