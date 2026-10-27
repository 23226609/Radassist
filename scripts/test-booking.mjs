// scripts/test-booking.mjs — chest X-ray booking calendar, time slots, and the
// patient chart window opened from the report.
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
Object.defineProperty(window, "location", {
  configurable: true,
  value: { href: "http://localhost:5173/#/review/CASE-1", origin: "http://localhost:5173", search: "" },
});

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderPatientPage } = await import("../src/components/patients.js");
const { renderRequestedPage } = await import("../src/components/cases.js");
const chartWindow = await import("../src/lib/chartWindow.js");

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
const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (node) => node.dispatchEvent(new window.Event("click"));
const buttonNamed = (root, name) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
const pad = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

console.log("\n=== X-ray booking ===");

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth();
const last = new Date(year, month + 1, 0).getDate();
const TIMES = ["09:00", "09:30", "10:00"];
const OPEN_DAY = key(new Date(year, month, last));
const FULL_DAY = key(new Date(year, month, last - 1));
const CLOSED_DAY = key(new Date(year, month, last - 2));

function monthDays(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00`); key(d) <= to; d.setDate(d.getDate() + 1)) {
    const day = key(d);
    let status = "past";
    if (day === OPEN_DAY) status = "few";
    if (day === FULL_DAY) status = "full";
    if (day === CLOSED_DAY) status = "closed";
    out.push({
      day,
      status,
      booked: day === FULL_DAY ? 20 : 17,
      quota: 20,
      left: status === "few" ? 3 : 0,
      slots: TIMES.map((time, i) => ({
        time,
        capacity: 2,
        booked: i === 0 ? 2 : 1,
        left: status === "few" && i > 0 ? 1 : 0,
        status: status === "few" ? (i === 0 ? "full" : "open") : status === "full" ? "full" : "past",
      })),
    });
  }
  return out;
}

const chart = {
  patient: { patientId: "PT-2026-0018", name: "Mei Chen", age: "61", sex: "Male", history: "Cough.", remarks: "" },
  cases: [
    { caseId: "CASE-1", status: "finalized", diagnosis: "Mild cardiomegaly", createdAt: "2026-09-01T00:00:00.000Z", chartFindings: [], chartFindingsState: "done" },
  ],
};

let asked = [];
let requested = null;
api.getPatient = async () => structuredClone(chart);
api.xrayAvailability = async (from, to) => {
  asked.push([from, to]);
  return { dailyQuota: 20, slotCapacity: 2, slotMinutes: 30, days: monthDays(from, to) };
};
api.requestExam = async (payload) => {
  requested = payload;
  chart.cases.push({ caseId: "CASE-REQ", status: "requested", scheduledAt: new Date(`${payload.day}T${payload.time}:00`).toISOString(), requestedByName: "Dr. Alex Wong" });
  return { case: {} };
};

state.user = { role: "doctor", userId: "d1", name: "Dr. Alex Wong" };
state.selectedPatientId = "PT-2026-0018";
state.page = "patient";
const root = document.getElementById("root");
await renderPatientPage({ target: root });
click(buttonNamed(root, "Book chest X-ray"));
await tick();
await tick();

const cell = (day) => root.querySelector(`#book-xray [data-day="${day}"]`);

test("opening the calendar loads this month's availability", () => {
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], key(new Date(year, month, 1)));
  assert.equal(asked[0][1], key(new Date(year, month, last)));
});

test("each day shows its status and the quota is explained", () => {
  assert.equal(cell(OPEN_DAY).getAttribute("data-status"), "few");
  assert.ok(cell(OPEN_DAY).textContent.includes("3 left"));
  assert.ok(cell(FULL_DAY).textContent.includes("Full"));
  assert.ok(cell(CLOSED_DAY).textContent.includes("Closed"));
  assert.ok(cell(FULL_DAY).disabled, "a full day cannot be chosen");
  assert.ok(cell(CLOSED_DAY).disabled, "a closed day cannot be chosen");
  assert.ok(root.querySelector("#book-xray").textContent.includes("Quota: 20 X-rays a day, 2 per 30-minute slot."));
  assert.ok(root.querySelector("#book-legend").textContent.includes("Few left"));
});

test("Confirm stays off until a day and a time are chosen", () => {
  assert.ok(buttonNamed(root, "Confirm booking").disabled);
  assert.equal(root.querySelector("#book-times"), null, "no times before a day is picked");
});

click(cell(FULL_DAY));
test("clicking a full day does nothing", () => {
  assert.equal(root.querySelector("#book-times"), null);
});

click(cell(OPEN_DAY));
test("choosing a day lists its times with what is free", () => {
  const times = root.querySelector("#book-times");
  assert.ok(times, "time list missing");
  assert.ok(times.textContent.includes("17 of 20 booked · 3 left"));
  const nine = times.querySelector('[data-time="09:00"]');
  assert.ok(nine.disabled, "a full slot cannot be chosen");
  assert.ok(nine.textContent.includes("Full"));
  assert.ok(times.querySelector('[data-time="09:30"]').textContent.includes("1 of 2 free"));
  assert.ok(root.querySelector("#book-summary").textContent.includes("Now choose a time."));
  assert.ok(buttonNamed(root, "Confirm booking").disabled);
});

click(root.querySelector('#book-times [data-time="09:30"]'));
test("choosing a time enables Confirm and shows the booking", () => {
  assert.ok(!buttonNamed(root, "Confirm booking").disabled);
  assert.ok(root.querySelector("#book-summary").textContent.includes("at 09:30"));
  assert.ok(cell(OPEN_DAY).textContent.includes("09:30"));
});

click(buttonNamed(root, "Confirm booking"));
await tick();
await tick();
test("Confirm books that day and time", () => {
  assert.deepEqual(requested, { patientId: "PT-2026-0018", day: OPEN_DAY, time: "09:30", urgent: false });
  assert.equal(root.querySelector("#book-xray"), null, "dialog closes after booking");
});

test("the chart shows the booked day, time and status", () => {
  const header = [...root.querySelectorAll("button")].find((b) => b.textContent.startsWith("X-ray booked"));
  assert.ok(header, "header button should show the booking");
  assert.ok(header.disabled, "a second booking is blocked while one is open");
  assert.ok(header.textContent.includes("09:30"));
  assert.ok(root.textContent.includes("Booked for"));
  assert.ok(/waiting for film/.test(root.textContent));
});

{
  api.listCases = async () => ({
    cases: [
      { caseId: "R2", patientId: "PT-2", name: "Later Patient", status: "requested", scheduledAt: "2030-01-02T02:00:00.000Z", requestedByName: "Dr. Alex Wong" },
      { caseId: "R1", patientId: "PT-1", name: "Sooner Patient", status: "requested", urgent: true, scheduledAt: "2030-01-01T01:30:00.000Z", requestedByName: "Dr. Alex Wong" },
    ],
  });
  state.user = { role: "technician", userId: "t1", name: "Jamie Lee" };
  const q = document.createElement("div");
  document.body.appendChild(q);
  await renderRequestedPage({ target: q });
  test("the technician queue shows the booked time, soonest first", () => {
    assert.ok(q.textContent.includes("Booked for"));
    const rows = [...q.querySelectorAll("tbody tr")].map((r) => r.textContent);
    assert.ok(rows[0].includes("Sooner Patient"));
    assert.ok(rows[0].includes("Urgent"));
    assert.ok(!rows[1].includes("Urgent"));
    assert.ok(rows[1].includes("Later Patient"));
    assert.ok(q.textContent.includes("1–2 of 2"));
  });
  q.remove();
}

{
  const many = Array.from({ length: 12 }, (_, i) => ({
    caseId: `R${i}`,
    patientId: `PT-${i}`,
    name: `Patient ${String(i).padStart(2, "0")}`,
    status: "requested",
    scheduledAt: new Date(Date.UTC(2030, 0, 1, i)).toISOString(),
    requestedByName: "Dr. Alex Wong",
  }));
  api.listCases = async () => ({ cases: many });
  const q = document.createElement("div");
  document.body.appendChild(q);
  await renderRequestedPage({ target: q });
  test("the technician queue pages 10 requests at a time", () => {
    assert.equal(q.querySelectorAll("tbody tr").length, 10);
    assert.ok(q.textContent.includes("1–10 of 12"));
    assert.ok(!q.textContent.includes("Patient 11"));
    click(buttonNamed(q, "Next"));
    assert.equal(q.querySelectorAll("tbody tr").length, 2);
    assert.ok(q.textContent.includes("Patient 10"));
    assert.ok(q.textContent.includes("Patient 11"));
    assert.ok(q.textContent.includes("11–12 of 12"));
  });
  q.remove();
}

{
  chart.patient.urgent = true;
  chart.cases = chart.cases.filter((c) => c.status !== "requested");
  requested = null;
  state.user = { role: "doctor", userId: "d1", name: "Dr. Alex Wong" };
  state.selectedPatientId = "PT-2026-0018";
  await renderPatientPage({ target: root });
  click(buttonNamed(root, "Book chest X-ray"));
  await tick();
  await tick();
  test("an urgent patient can book a full day and a full time", () => {
    assert.ok(!cell(FULL_DAY).disabled, "a full day stays open for an urgent patient");
    assert.ok(root.querySelector("#book-xray").textContent.includes("a full day can still take the booking"));
    click(cell(FULL_DAY));
  });
  const fullTimes = root.querySelector("#book-times");
  test("a full time on that day can be chosen", () => {
    assert.ok(fullTimes, "times for the full day");
    const nine = fullTimes.querySelector('[data-time="09:00"]');
    assert.ok(!nine.disabled);
    assert.ok(nine.textContent.includes("Urgent"));
    click(nine);
    assert.ok(!buttonNamed(root, "Confirm booking").disabled);
  });
  click(buttonNamed(root, "Confirm booking"));
  await tick();
  await tick();
  test("Confirm sends the booking as urgent", () => {
    assert.deepEqual(requested, { patientId: "PT-2026-0018", day: FULL_DAY, time: "09:00", urgent: true });
  });
  chart.patient.urgent = false;
}

console.log("\n=== patient chart window ===");

{
  state.user = { role: "radiologist", userId: "r1", name: "Dr. Priya Nair" };
  const opened = [];
  window.open = (url, name, features) => { opened.push({ url, name, features }); return { focus() {} }; };
  const host = document.createElement("div");
  document.body.appendChild(host);
  host.appendChild(chartWindow.patientChartButton({ patientId: "PT-2026-0018", name: "Mei Chen" }));
  click(buttonNamed(host, "Patient chart"));
  test("Patient chart opens that patient in its own window", () => {
    assert.equal(opened.length, 1);
    const url = new URL(opened[0].url);
    assert.equal(url.searchParams.get("view"), "patient");
    assert.equal(url.searchParams.get("patientId"), "PT-2026-0018");
    assert.ok(/popup/.test(opened[0].features));
    assert.equal(opened[0].name, "radassist-patient");
  });

  window.open = () => null;
  state.page = "review";
  click(buttonNamed(host, "Patient chart"));
  await tick();
  await tick();
  test("a blocked pop-up shows the chart as a floating panel on the report page", () => {
    const panel = document.getElementById("patient-popup");
    assert.ok(panel, "fallback panel missing");
    assert.equal(panel.getAttribute("aria-modal"), "false");
    assert.ok(panel.textContent.includes("Mild cardiomegaly"));
  });
  chartWindow.closeChartPanel();
  host.remove();

  state.user = { role: "admin", userId: "a1", name: "Admin" };
  const opener = { closed: false, location: { hash: "" }, focus() { this.focused = true; } };
  window.opener = opener;
  window.location.search = "?view=patient&patientId=PT-2026-0018&name=Mei%20Chen";
  const win = document.createElement("div");
  document.body.appendChild(win);
  assert.ok(chartWindow.isChartWindow());
  chartWindow.renderChartWindow({ target: win });
  await tick();
  await tick();
  test("the window shows the chart without navigation-only buttons", () => {
    assert.ok(win.textContent.includes("Patient chart · Mei Chen (PT-2026-0018)"));
    assert.ok(win.textContent.includes("Mild cardiomegaly"));
    assert.ok(!buttonNamed(win, "Delete"), "no Delete in the window");
    assert.ok(!buttonNamed(win, "New case"), "no New case in the window");
    assert.ok(!buttonNamed(win, "Enquiry of Patient Master Index"));
  });
  const study = [...win.querySelectorAll("button")].find((b) => b.textContent.includes("CASE-1") && b.textContent.includes("Mild"));
  click(study);
  test("a study clicked in the window opens in the main window", () => {
    assert.equal(opener.location.hash, "#/cases/CASE-1");
    assert.ok(opener.focused);
  });
  win.remove();
  delete window.opener;
  window.location.search = "";
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
