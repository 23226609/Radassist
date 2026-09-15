// scripts/test-shell-menu.mjs
// Desktop and mobile share the hamburger so the film can use the full width.

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

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
state.page = "review";

const { root } = Shell({ onLogout() {} });
document.body.appendChild(root);

console.log("\n=== shell menu ===");

test("website chrome shows the hamburger menu", () => {
  const btn = root.querySelector("#app-menu-button");
  assert.ok(btn, "Open menu button missing");
  assert.equal(btn.getAttribute("aria-label"), "Open menu");
  assert.ok(!btn.className.includes("lg:hidden"), "hamburger must stay visible on desktop");
});

test("the sidebar is a drawer, not a permanent desktop column", () => {
  const drawer = root.querySelector("#app-drawer");
  assert.ok(drawer, "menu drawer missing");
  assert.ok(drawer.classList.contains("hidden"), "drawer should start closed");
  assert.ok(!drawer.className.includes("lg:hidden"), "drawer must be openable on desktop");
  assert.equal(root.querySelectorAll("aside").length, 1, "no second always-on sidebar");
});

test("hamburger opens the menu for a larger content area when closed", () => {
  root.querySelector("#app-menu-button").click();
  assert.ok(!root.querySelector("#app-drawer").classList.contains("hidden"));
  assert.equal(root.querySelector("#app-menu-button").getAttribute("aria-expanded"), "true");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
