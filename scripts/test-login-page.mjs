// scripts/test-login-page.mjs
//
// The login screen: the one-click demo accounts still sign in, a typed login
// works, a wrong password shows an error, and the Register screen explains that
// self-signup is closed. The API is a stub, so no server is needed.
//
//   node scripts/test-login-page.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<!doctype html><html><body><div id='app'></div></body></html>");
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderLoginPage, renderRegisterPage } = await import("../src/components/login.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const app = document.getElementById("app");
const logins = [];
let loginResult = (username) => ({ token: "tok", user: { userId: "u1", name: `User ${username}`, role: "technician" } });
api.login = async (username, password) => {
  logins.push({ username, password });
  const out = loginResult(username, password);
  if (out instanceof Error) throw out;
  return out;
};
const click = async (node) => {
  assert.ok(node, "control not found");
  node.dispatchEvent(new window.Event("click"));
  await tick(40);
};
const quick = () => [...app.querySelectorAll("button.quick-login")];

console.log("\n=== the login screen ===");

await test("it offers the four one-click demo accounts", () => {
  state.page = "login";
  renderLoginPage();
  const text = quick().map((b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(text.length, 4);
  for (const role of ["technician", "radiologist", "doctor", "admin"]) {
    assert.ok(text.some((t) => t.toLowerCase().includes(role)), `${role} account missing`);
  }
});

await test("clicking a demo account signs in with that account's username and a password", async () => {
  logins.length = 0;
  renderLoginPage();
  await click(quick().find((b) => /technician/i.test(b.textContent)));
  assert.equal(logins.length, 1);
  assert.equal(logins[0].username, "tech");
  assert.ok(String(logins[0].password).length >= 6, "the demo button sends a password");
  assert.equal(state.page, "dashboard");
  assert.equal(state.user.name, "User tech");
  assert.equal(JSON.parse(store["radassist.auth"]).token, "tok", "the session is kept as before");
});

await test("each of the four demo accounts signs in under its own username", async () => {
  for (const [role, username] of [["radiologist", "priya"], ["doctor", "doctor"], ["admin", "admin"]]) {
    logins.length = 0;
    state.page = "login";
    renderLoginPage();
    await click(quick().find((b) => new RegExp(role, "i").test(b.textContent)));
    assert.equal(logins[0]?.username, username);
    assert.ok(String(logins[0]?.password || "").length >= 6);
  }
});

await test("typing a username and password and pressing Sign in works", async () => {
  logins.length = 0;
  state.page = "login";
  renderLoginPage();
  const [user, pass] = app.querySelectorAll("input");
  user.value = "someone";
  user.dispatchEvent(new window.Event("input"));
  pass.value = "typed-password";
  pass.dispatchEvent(new window.Event("input"));
  const signIn = [...app.querySelectorAll("button")].find((b) => b.textContent.trim() === "Sign in");
  await click(signIn);
  assert.deepEqual(logins[0], { username: "someone", password: "typed-password" });
});

await test("a wrong password shows the server's message and stays on the login page", async () => {
  loginResult = () => Object.assign(new Error("Invalid credentials."), { status: 401 });
  state.page = "login";
  renderLoginPage();
  await click(quick()[0]);
  assert.ok(app.querySelector("[role=alert]")?.textContent.includes("Invalid credentials."));
  assert.equal(state.page, "login");
});

console.log("\n=== the Register screen ===");

await test("when the server refuses (self-signup is closed) it says so plainly", async () => {
  api.register = async () => { throw Object.assign(new Error("Please log in to continue."), { status: 401 }); };
  renderRegisterPage();
  const inputs = [...app.querySelectorAll("input")];
  const values = ["New Person", "newperson", "new@radassist.test", "abcdef", "Radiology"];
  inputs.forEach((input, i) => { input.value = values[i]; input.dispatchEvent(new window.Event("input")); });
  const create = [...app.querySelectorAll("button")].find((b) => /Create account/.test(b.textContent));
  await click(create);
  const text = app.textContent;
  assert.ok(text.includes("Self-registration is closed"), text);
  assert.ok(!text.includes("Please log in to continue."));
});

await test("any other failure still shows the server's own message", async () => {
  api.register = async () => { throw Object.assign(new Error("Username or email already taken."), { status: 400 }); };
  renderRegisterPage();
  const inputs = [...app.querySelectorAll("input")];
  const values = ["New Person", "newperson", "new@radassist.test", "abcdef", "Radiology"];
  inputs.forEach((input, i) => { input.value = values[i]; input.dispatchEvent(new window.Event("input")); });
  await click([...app.querySelectorAll("button")].find((b) => /Create account/.test(b.textContent)));
  assert.ok(app.textContent.includes("Username or email already taken."));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
