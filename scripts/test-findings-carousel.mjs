// scripts/test-findings-carousel.mjs
//
// Renders the real review page into a linkedom DOM and drives the findings
// carousel, so this exercises src/components/review.js itself rather than a
// copy of its logic.
//
//   npm install --no-save linkedom
//   node scripts/test-findings-carousel.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='root'></div></body></html>"
);

// review.js and its imports expect a browser environment.
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
try {
  window.location.href = "http://localhost:5173/";
} catch {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost:5173/"),
  });
}
let openedPopup = null;
window.open = (url, name, features) => {
  openedPopup = { url: String(url), name, features };
  return { closed: false };
};

// linkedom exposes select.value as getter-only; real browsers let you assign
// it, which is what dom.js does when building the pattern dropdown.
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
const { renderReviewPage } = await import("../src/components/review.js");

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

function makeFinding(label, confidence, status = "pending") {
  return {
    _id: `ai-${label}`,
    label,
    confidence,
    bbox: [10, 10, 20, 20],
    location: "",
    size: "",
    pattern: "Other",
    sentence: label,
    status,
    source: "AI",
  };
}

const testCase = {
  caseId: "CASE-CAROUSEL-1",
  patientId: "PT-0001",
  age: "29",
  sex: "Female",
  status: "completed",
  reportText: "Chest X-Ray Report\n\n1. Lungs:\n   - The lungs are clear.",
  imageId: null,
  findings: [
    makeFinding("Heart size normal", 0.9, "accepted"),
    makeFinding("Lungs clear", 0.6),
    makeFinding("Low confidence item", 0.2, "rejected"),
  ],
};

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
state.cases = [testCase];
state.selectedCaseId = testCase.caseId;
api.getCase = async () => ({ case: structuredClone(testCase) });
api.fetchImage = async () => {
  throw new Error("no image in test");
};
api.summariseFindings = async () => ({ added: 0, kept: 3, case: structuredClone(testCase) });

const root = document.getElementById("root");
await renderReviewPage({ target: root });

const text = () => root.textContent.replace(/\s+/g, " ");
const cards = () => root.querySelectorAll("article");
const byTitle = (t) => root.querySelector(`[title="${t}"]`);
const dots = () =>
  [...root.querySelectorAll("button")].filter((b) => /^\d+\. /.test(b.getAttribute("title") || ""));

console.log("\n=== findings carousel ===");

test("renders exactly one finding card at a time", () => {
  assert.equal(cards().length, 1, `expected 1 card, saw ${cards().length}`);
});

test("shows a position counter for the three findings", () => {
  assert.ok(text().includes("1 of 3"), `counter missing in: ${text().slice(0, 200)}`);
});

test("shows the first finding first", () => {
  assert.ok(text().includes("Heart size normal"));
});

test("renders one navigation dot per finding", () => {
  assert.equal(dots().length, 3, `expected 3 dots, saw ${dots().length}`);
});

test("next button advances to the second finding", () => {
  byTitle("Next finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("2 of 3"), "counter did not advance");
  assert.ok(text().includes("Lungs clear"), "second finding not shown");
  assert.equal(cards().length, 1, "more than one card after advancing");
});

test("previous button goes back", () => {
  byTitle("Previous finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("1 of 3"), "counter did not go back");
  assert.ok(text().includes("Heart size normal"));
});

test("previous from the first finding wraps to the last", () => {
  byTitle("Previous finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("3 of 3"), `expected wrap to 3 of 3, got: ${text().slice(0, 120)}`);
  assert.ok(text().includes("Low confidence item"));
});

test("next from the last finding wraps to the first", () => {
  byTitle("Next finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("1 of 3"), "did not wrap back to the first finding");
});

test("clicking a dot jumps straight to that finding", () => {
  dots()[2].dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("3 of 3"));
  assert.ok(text().includes("Low confidence item"));
});

test("does not require a Summarise with Azure AI button", () => {
  const btn = [...root.querySelectorAll("button")].find((b) =>
    /Summarise with Azure AI/.test(b.textContent)
  );
  assert.equal(btn, undefined, "manual Azure button should be gone — summarisation runs on page open");
});

test("findings have no Accept or Reject actions", () => {
  const labels = [...root.querySelectorAll("button")].map((b) => b.textContent.trim());
  assert.ok(!labels.includes("Accept"), "Accept should be gone");
  assert.ok(!labels.includes("Reject"), "Reject should be gone");
});

test("the confidence threshold slider is gone", () => {
  assert.ok(!text().includes("Confidence threshold"), "threshold slider should be gone");
});

test("the review page offers Word and PDF downloads of the report", () => {
  const labels = [...root.querySelectorAll("button")].map((b) => b.textContent.trim());
  assert.ok(labels.includes("Word"), "Word download missing");
  assert.ok(labels.includes("PDF"), "PDF download missing");
});

test("does not show the full report on the view page", () => {
  assert.ok(!text().includes("Final report text"), "report editor should not be on the view page");
  assert.equal(root.querySelector('[aria-label="Report"]'), null, "report should open in a new window, not an overlay");
});

test("the remarks box sits under the findings in the right column", () => {
  const column = root.querySelector("section.flex.flex-col");
  assert.ok(column, "findings column missing");
  const cardsInColumn = [...column.querySelectorAll(":scope > .card")];
  assert.ok(cardsInColumn.length >= 2, "expected findings and remarks cards");
  assert.ok(cardsInColumn[0].textContent.includes("Finding") || cardsInColumn[0].textContent.includes("of"),
    "findings card should be first in the right column");
  assert.ok(cardsInColumn.at(-1).textContent.includes("Remarks"),
    "remarks should sit under the findings");
  const remarksBox = cardsInColumn.at(-1).querySelector("textarea");
  assert.ok(remarksBox, "remarks box missing");
  assert.ok(!remarksBox.disabled && !remarksBox.hasAttribute("readonly") && !remarksBox.hasAttribute("disabled"),
    "doctors must be able to type remarks");
});

test("Report opens a new window for the stored report", () => {
  const btn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Report");
  assert.ok(btn, "Report button missing");
  openedPopup = null;
  btn.dispatchEvent(new window.Event("click"));
  assert.ok(openedPopup, "window.open was not called");
  assert.ok(/view=report/.test(openedPopup.url), `expected view=report in ${openedPopup.url}`);
  assert.ok(/caseId=CASE-CAROUSEL-1/.test(openedPopup.url), `expected case id in ${openedPopup.url}`);
});

{
  let saved = null;
  api.updateCase = async (_id, payload) => {
    saved = payload;
    return { case: { ...structuredClone(testCase), ...payload } };
  };
  const box = root.querySelector("textarea");
  box.value = "Possible old rib fracture on the left.";
  box.dispatchEvent(new window.Event("input"));
  const saveBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save remarks");
  saveBtn.dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));

  test("saving remarks writes them into the MongoDB report", () => {
    assert.ok(saved, "updateCase was not called");
    assert.ok(saved.reportText.includes("Radiologist remarks"), "remarks heading missing from report");
    assert.ok(saved.reportText.includes("Possible old rib fracture on the left."), "remarks text missing from report");
    assert.equal(saved.remarks, "Possible old rib fracture on the left.");
  });
}

{
  const finalized = { ...structuredClone(testCase), status: "finalized", remarks: "" };
  state.cases = [finalized];
  state.selectedCaseId = finalized.caseId;
  api.getCase = async () => ({ case: structuredClone(finalized) });
  let saved = null;
  api.updateCase = async (_id, payload) => {
    saved = payload;
    return { case: { ...structuredClone(finalized), ...payload } };
  };
  const finRoot = document.createElement("div");
  document.body.appendChild(finRoot);
  await renderReviewPage({ target: finRoot });

  test("finalized cases still have a writable remarks box", () => {
    const box = finRoot.querySelector("#remarks-box");
    assert.ok(box, "remarks box missing on finalized case");
    assert.ok(!box.disabled && !box.hasAttribute("readonly"), "remarks must stay writable after finalize");
    assert.ok([...finRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save remarks"));
    assert.ok(![...finRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Finalize & approve"));
  });

  const box = finRoot.querySelector("#remarks-box");
  box.value = "Follow up in clinic.";
  box.dispatchEvent(new window.Event("input"));
  [...finRoot.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save remarks")
    .dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));

  test("finalized remarks save as notes and do not rewrite the report", () => {
    assert.ok(saved, "updateCase was not called");
    assert.equal(saved.remarks, "Follow up in clinic.");
    assert.equal(saved.reportText, undefined, "finalized report text must stay locked");
    assert.equal(saved.findings, undefined, "finalized findings must stay locked");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
