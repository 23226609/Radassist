// scripts/test-shell-menu.mjs
// Permanent MODULES column, matching the COMP4126 CMS simulator shell.

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

const { state } = await import("../src/state.js");
const { Shell } = await import("../src/components/header.js");

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

state.user = { role: "radiologist", userId: "u1", name: "Dr Test" };
state.page = "dashboard";

const { root } = Shell({ onLogout() {} });
document.body.appendChild(root);

console.log("\n=== shell menu ===");

test("the CMS shell shows a permanent modules column", () => {
  const nav = root.querySelector("#app-modules");
  assert.ok(nav, "modules column missing");
  assert.ok(!nav.classList.contains("hidden"), "modules column should stay visible");
  assert.ok(root.textContent.includes("MODULES"));
  assert.ok(root.textContent.includes("INPATIENT"));
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.includes("Sign out")));
  assert.equal(root.querySelector("#app-menu-button"), null);
});

test("the review page hides the modules behind a Menu button", () => {
  state.page = "review";
  const { root: reviewRoot } = Shell({ onLogout() {} });
  state.page = "dashboard";
  assert.ok(reviewRoot.classList.contains("h-screen"));
  const nav = reviewRoot.querySelector("#app-modules");
  const menu = reviewRoot.querySelector("#app-menu-button");
  const backdrop = reviewRoot.querySelector("#app-modules-backdrop");
  assert.ok(nav.classList.contains("hidden"), "modules should start hidden");
  menu.dispatchEvent(new window.Event("click"));
  assert.ok(!nav.classList.contains("hidden"), "Menu did not open the modules");
  assert.equal(menu.getAttribute("aria-expanded"), "true");
  assert.ok([...nav.querySelectorAll("button")].some((b) => b.textContent.includes("X-ray Worklist")));
  backdrop.dispatchEvent(new window.Event("click"));
  assert.ok(nav.classList.contains("hidden"), "clicking outside did not close the modules");
  menu.dispatchEvent(new window.Event("click"));
  menu.dispatchEvent(new window.Event("click"));
  assert.ok(nav.classList.contains("hidden"), "Menu did not close the modules");
});

test("radiologists do not see Audit log in the menu", () => {
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Audit log"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.includes("Lab Orders")));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.includes("Medication Chart")));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Users"));
});

{
  state.user = { role: "technician", userId: "n1", name: "Jamie Lee" };
  const { root: nurseRoot } = Shell({ onLogout() {} });
  document.body.appendChild(nurseRoot);
  test("technicians do not see Audit log in the menu", () => {
    assert.ok([...nurseRoot.querySelectorAll("button")].some((b) => b.textContent.includes("Requested case")));
    assert.ok(![...nurseRoot.querySelectorAll("button")].some((b) => b.textContent.includes("Lab Orders")));
    assert.ok(![...nurseRoot.querySelectorAll("button")].some((b) => b.textContent.includes("Medication Chart")));
    assert.ok(![...nurseRoot.querySelectorAll("button")].some((b) => b.textContent.includes("X-ray Worklist")));
    assert.ok(![...nurseRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Audit log"));
    assert.ok(![...nurseRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Users"));
  });
}

{
  state.user = { role: "admin", userId: "a1", name: "Admin" };
  const { root: adminRoot } = Shell({ onLogout() {} });
  document.body.appendChild(adminRoot);
  test("admins see Users in the menu", () => {
    assert.ok([...adminRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Users"));
    assert.ok([...adminRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Audit log"));
    assert.ok(![...adminRoot.querySelectorAll("button")].some((b) => b.textContent.includes("Medication Chart")));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
