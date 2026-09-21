// scripts/test-users-page.mjs
// Admin user list: enable / disable.

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

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderUsersPage } = await import("../src/components/users.js");

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

const USERS = [
  { userId: "USR-ADMIN-0001", username: "admin", name: "System Admin", role: "admin", isActive: true },
  { userId: "USR-DOCTOR-0001", username: "doctor", name: "Dr. Alex Wong", role: "doctor", isActive: true },
  { userId: "USR-NURSE-0001", username: "nurse", name: "Jamie Lee", role: "nurse", isActive: false },
];

state.user = { role: "admin", userId: "USR-ADMIN-0001", name: "System Admin" };
api.listUsers = async () => ({ users: structuredClone(USERS) });
let toggled = null;
api.setUserActive = async (id, isActive) => {
  toggled = { id, isActive };
  return { user: { userId: id, isActive } };
};

const root = document.getElementById("root");
await renderUsersPage({ target: root });

console.log("\n=== users page ===");

test("lists accounts with enable/disable", () => {
  assert.ok(root.textContent.includes("Dr. Alex Wong"));
  assert.ok(root.textContent.includes("Disabled"));
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Disable"));
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Enable"));
});

test("does not let an admin disable themselves", () => {
  const rows = [...root.querySelectorAll("tr")];
  const self = rows.find((r) => r.textContent.includes("System Admin"));
  assert.ok(self);
  assert.ok(self.textContent.includes("You"));
});

window.confirm = () => true;
[...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Disable").click();
await new Promise((r) => setTimeout(r, 0));

test("disable sends isActive false", () => {
  assert.ok(toggled);
  assert.equal(toggled.isActive, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
