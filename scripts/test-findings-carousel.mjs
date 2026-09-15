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
  patientName: "Alex Wong",
  createdByName: "Dr. Priya Nair",
  age: "29",
  sex: "Female",
  status: "completed",
  urgent: false,
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
let savedPayload = null;
api.updateCase = async (_id, payload) => {
  savedPayload = payload;
  return { case: { ...structuredClone(testCase), ...payload } };
};

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

test("shows the patient name on the view page", () => {
  assert.ok(text().includes("Alex Wong"));
});

test("shows the doctor in charge on the view page", () => {
  assert.ok(text().includes("Doctor in charge"));
  assert.ok(text().includes("Dr. Priya Nair"));
});

test("doctors can mark the case urgent", () => {
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Mark urgent"));
});

test("renders one navigation dot per finding", () => {
  assert.equal(dots().length, 3, `expected 3 dots, saw ${dots().length}`);
});

test("Hide boxes removes the overlays from the film", () => {
  assert.ok(root.querySelector("#toggle-bboxes"), "Hide boxes button missing");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1, "only the active finding box should show");
  assert.ok(root.textContent.includes("F1"), "boxes should start visible");
  root.querySelector("#toggle-bboxes").dispatchEvent(new window.Event("click"));
  assert.equal(root.querySelector("#toggle-bboxes")?.textContent.trim(), "Show boxes");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 0, "boxes still visible after hide");
});

test("Show boxes brings the overlays back", () => {
  root.querySelector("#toggle-bboxes").dispatchEvent(new window.Event("click"));
  assert.equal(root.querySelector("#toggle-bboxes")?.textContent.trim(), "Hide boxes");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
  assert.ok(root.textContent.includes("F1"));
});

test("next button advances to the second finding", () => {
  byTitle("Next finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("2 of 3"), "counter did not advance");
  assert.ok(text().includes("Lungs clear"), "second finding not shown");
  assert.equal(cards().length, 1, "more than one card after advancing");
  assert.ok(root.textContent.includes("F2"), "active box should follow the card");
  assert.ok(!root.textContent.includes("F1"), "previous finding box should hide");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
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

test("Add manually opens a new card at the end of the carousel", () => {
  const add = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "+ Add manually");
  assert.ok(add, "Add manually button missing");
  add.dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("4 of 4"), `expected 4 of 4 after add, got: ${text().slice(0, 180)}`);
  assert.ok(text().includes("NEW FINDING (unsaved)"), "new finding card not shown");
  assert.ok(text().includes("Finish this finding"), "Finish this finding button missing");
  assert.ok(root.querySelector("#delete-manual-finding"), "unsaved manual cards should have Delete");
  assert.ok(text().includes("in either order"), "either-order hint missing");
  const label = root.querySelector("input[id^='finding-label-tmp-']");
  assert.ok(label, "new finding label input missing");
  assert.equal(label.value, "New finding");
  assert.equal(cards().length, 1, "carousel should still show one card");
  assert.ok(text().includes("Manual"), "manual cards should say Manual, not a confidence %");
  assert.ok(![...root.querySelectorAll("article")].some((n) => /50%/.test(n.textContent)),
    "manual cards should not show a 50% score");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 0, "manual findings wait for a drawn box");
  assert.ok(text().includes("Drag on the X-ray to draw a box"));
  const loc = root.querySelector("input[id^='finding-location-tmp-']");
  loc.value = "Left lower zone";
  loc.dispatchEvent(new window.Event("input", { bubbles: true }));
  const size = root.querySelector("input[id^='finding-size-tmp-']");
  size.value = "2 cm";
  size.dispatchEvent(new window.Event("input", { bubbles: true }));
});

await new Promise((r) => setTimeout(r, 500));
test("a new card does not autosave until Finish this finding", () => {
  assert.equal(savedPayload, null, "typing a new card must not autosave until Finish this finding");
});

{
  const proto = window.HTMLElement.prototype;
  proto.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {},
  });
  const stage = root.querySelector("#xray-stage");
  function point(type, x, y) {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.clientX = x;
    ev.clientY = y;
    ev.button = 0;
    stage.dispatchEvent(ev);
  }
  point("pointerdown", 10, 20);
  point("pointermove", 40, 50);
  point("pointerup", 40, 50);
}

test("dragging on the film draws a box on the unsaved manual finding", () => {
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
  const box = root.querySelector("[data-bbox]");
  assert.equal(box.style.left, "10%");
  assert.equal(box.style.top, "20%");
  assert.equal(box.style.width, "30%");
  assert.equal(box.style.height, "30%");
  assert.ok(root.querySelector("#finish-manual-finding"),
    "drawing a box first must not hide Finish this finding");
  assert.ok(text().includes("NEW FINDING (unsaved)"),
    "card must stay unsaved until Finish this finding");
  assert.equal(savedPayload, null, "drawing a box must not autosave the card");
});

savedPayload = null;
{
  const finish = root.querySelector("#finish-manual-finding");
  assert.ok(finish, "Finish this finding button missing");
  finish.click();
  await new Promise((r) => setTimeout(r, 50));
}

test("Finish this finding saves details and the drawn box together", () => {
  assert.ok(savedPayload, "Finish this finding should persist the card");
  const manual = savedPayload.findings.find((f) => f.source === "manual");
  assert.ok(manual, "manual finding missing from save");
  assert.equal(manual.location, "Left lower zone");
  assert.equal(manual.size, "2 cm");
  assert.deepEqual(manual.bbox, [10, 20, 30, 30]);
  assert.ok(!String(manual._id || "").startsWith("tmp-"), "draft tmp- id must not be written to Mongo");
  assert.ok(!String(manual.id || "").startsWith("tmp-"), "draft tmp- id must not be written to Mongo");
});

test("saved manual findings can still be deleted", () => {
  const del = root.querySelector("#delete-manual-finding");
  assert.ok(del, "Delete should stay on saved manual cards");
  assert.equal(del.textContent.trim(), "Delete");
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

{
  const btn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Report");
  openedPopup = null;
  savedPayload = null;
  btn.dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  test("Report opens a new window for the stored report", () => {
    assert.ok(btn, "Report button missing");
    assert.ok(openedPopup, "window.open was not called");
    assert.ok(/view=report/.test(openedPopup.url), `expected view=report in ${openedPopup.url}`);
    assert.ok(/caseId=CASE-CAROUSEL-1/.test(openedPopup.url), `expected case id in ${openedPopup.url}`);
  });
}

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

  test("hand-added findings are written into the exported report", () => {
    assert.ok(saved.reportText.includes("Clinician-added findings"), "manual findings heading missing from report");
    assert.ok(saved.reportText.includes("New finding"), "manual finding label missing from report");
    assert.ok(Array.isArray(saved.findings), "findings were not persisted");
    assert.ok(saved.findings.some((f) => f.source === "manual" && f.label === "New finding"),
      "manual finding missing from saved findings list");
  });
}

{
  const typeFirst = structuredClone(testCase);
  state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
  state.cases = [typeFirst];
  state.selectedCaseId = typeFirst.caseId;
  api.getCase = async () => ({ case: structuredClone(typeFirst) });
  let saved = null;
  api.updateCase = async (_id, payload) => {
    saved = payload;
    return { case: { ...structuredClone(typeFirst), ...payload } };
  };
  const tfRoot = document.createElement("div");
  document.body.appendChild(tfRoot);
  await renderReviewPage({ target: tfRoot });
  [...tfRoot.querySelectorAll("button")].find((b) => b.textContent.trim() === "+ Add manually")
    .dispatchEvent(new window.Event("click"));
  const loc = tfRoot.querySelector("input[id^='finding-location-tmp-']");
  loc.value = "Right apex";
  loc.dispatchEvent(new window.Event("input", { bubbles: true }));
  const label = tfRoot.querySelector("input[id^='finding-label-tmp-']");
  label.value = "Apical opacity";
  label.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  test("writing details first does not autosave the unfinished card", () => {
    assert.equal(saved, null, "details-first must wait for Finish this finding");
  });
  tfRoot.querySelector("#finish-manual-finding").click();
  await new Promise((r) => setTimeout(r, 50));
  test("Finish this finding saves details even when no box was drawn", () => {
    assert.ok(saved, "Finish this finding should persist details-first cards");
    const manual = saved.findings.find((f) => f.source === "manual");
    assert.ok(manual, "manual finding missing from save");
    assert.equal(manual.label, "Apical opacity");
    assert.equal(manual.location, "Right apex");
    assert.deepEqual(manual.bbox, []);
    assert.ok(!String(manual._id || "").startsWith("tmp-"));
  });
  saved = null;
  const del = tfRoot.querySelector("#delete-manual-finding");
  test("doctors can delete a saved manual finding", () => {
    assert.ok(del, "Delete missing on saved manual card");
  });
  del.click();
  await new Promise((r) => setTimeout(r, 50));
  test("deleting a manual finding removes it from Mongo and the carousel", () => {
    assert.ok(saved, "Delete should persist immediately");
    assert.ok(!(saved.findings || []).some((f) => f.source === "manual"),
      "deleted manual finding should not remain in the save payload");
    assert.equal((saved.findings || []).length, 3, "AI findings should stay");
    assert.ok(tfRoot.textContent.replace(/\s+/g, " ").includes("3 of 3"));
    assert.equal(tfRoot.querySelector("#delete-manual-finding"), null);
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

  test("doctors can still mark a finalized case urgent", () => {
    assert.ok([...finRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Mark urgent"));
  });
}

{
  let flagged = null;
  api.updateCase = async (_id, payload) => {
    flagged = payload;
    return { case: { ...structuredClone(testCase), ...payload } };
  };
  const urgentRoot = document.createElement("div");
  document.body.appendChild(urgentRoot);
  await renderReviewPage({ target: urgentRoot });
  [...urgentRoot.querySelectorAll("button")].find((b) => b.textContent.trim() === "Mark urgent")
    .dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));

  test("marking urgent saves { urgent: true } on the case", () => {
    assert.ok(flagged, "updateCase was not called");
    assert.equal(flagged.urgent, true);
  });
}

{
  state.user = { role: "nurse", userId: "n1", name: "Nurse" };
  const nurseRoot = document.createElement("div");
  document.body.appendChild(nurseRoot);
  await renderReviewPage({ target: nurseRoot });

  test("nurses see the name but cannot mark a case urgent", () => {
    assert.ok(nurseRoot.textContent.includes("Alex Wong"));
    assert.ok(![...nurseRoot.querySelectorAll("button")].some((b) => /urgent/i.test(b.textContent)));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
