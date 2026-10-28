// Inpatient modules in the COMP4126 CMS layout.
// Patient identity and X-ray cases stay on the existing API.
// Ward, vitals, labs, medicines, and care notes are stored on the patient chart.

import { el, mount } from "../dom.js";
import { api } from "../api.js";
import { state, setPage, toast } from "../state.js";
import { patientDisplayName } from "../lib/tags.js";
import { canEditPatient, canArrangeLab } from "../lib/roles.js";

const BEDS = ["4A-01", "4A-02", "4A-03", "4A-04", "4B-01", "4B-02", "4B-03", "4B-04"];
const INPUT = "w-full rounded border border-gray-400 bg-white px-2 py-1.5 text-sm outline-none focus:border-ha-blue focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100";
const BTN = "rounded bg-ha-blue px-3 py-2 text-xs font-bold text-white hover:bg-[#074f85] disabled:opacity-40";

function cmsWindow(title, ...body) {
  return el("div", { class: "flex h-full min-h-[70vh] flex-col p-2" },
    el("div", { class: "relative flex h-full flex-col border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-2 shadow-sm" },
      el("div", { class: "flex items-center gap-2 border-b border-[#d9d3bc] bg-ha-paper px-2 py-1 text-sm font-bold text-stone-900" }, title),
      ...body
    )
  );
}

function activePatientBar(patient, { compact = false } = {}) {
  if (!patient) return null;
  const where = [patient.ward, patient.bed].filter(Boolean).join(" ");
  return el("div", {
    class: compact
      ? "mt-1 flex shrink-0 justify-between gap-2 border border-gray-400 bg-[#ffffcc] px-2 py-1 text-xs font-bold"
      : "my-2 flex justify-between border border-gray-400 bg-[#ffffcc] p-2 text-sm font-bold",
  },
    el("span", { class: "min-w-0 truncate" }, `Active Patient: ${patientDisplayName(patient) || patient.patientId} (${patient.patientId})`),
    el("span", { class: "shrink-0" }, where ? `Location: ${where}` : "Location: not admitted")
  );
}

const BEVEL = "border border-gray-400 border-b-gray-600 border-r-gray-600 bg-[#ece9d8] px-3 py-1 text-xs font-bold hover:bg-gray-200 disabled:opacity-50";

function frame(title, ...body) {
  return cmsWindow(title, el("div", { class: "mt-2 border-2 border-gray-500 bg-white p-3" }, ...body));
}

function wardOf(bed) {
  return String(bed || "").startsWith("4B") ? "4B" : String(bed || "").startsWith("4A") ? "4A" : "";
}

function num(value) {
  const n = parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Teaching-screen clock: 2026/9/21 上午10:35:53 or 2026/9/21 下午2:35:53.
export function cmsAssessmentStamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const period = h < 12 ? "上午" : "下午";
  const hour = h % 12 || 12;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${period}${hour}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Three review states from the CMS sepsis screen.
// Urgent: SpO2 ≤91, RR ≥25, or the two-criterion proxy (RR ≥22 and SBP ≤100).
// Abnormal: outside the adult teaching range, but not urgent.
// Otherwise: No configured trigger.
export function reviewState(obs = {}, heartRate = "") {
  const hr = num(obs.hr ?? heartRate);
  const rr = num(obs.rr);
  const sbp = num(obs.sbp);
  const spo2 = num(obs.spo2);
  const temp = num(obs.temp);
  const lactate = num(obs.lactate);
  const wbc = num(obs.wbc);
  const crp = num(obs.crp);
  const urgent = [];
  if (spo2 != null && spo2 <= 91) urgent.push("SpO₂ ≤91% (adult standard oxygen scale)");
  if (rr != null && sbp != null && rr >= 22 && sbp <= 100) {
    urgent.push("Two-criterion qSOFA proxy: RR ≥22 and systolic BP ≤100");
  }
  if (rr != null && rr >= 25) urgent.push("Respiratory rate ≥25 breaths/min");
  if (urgent.length) {
    return { level: "urgent", title: "Urgent review", reasons: [...urgent, "Unacknowledged alert"] };
  }

  const abnormal = [];
  if (hr != null && (hr < 60 || hr > 100)) abnormal.push(`Heart rate ${hr}`);
  if (rr != null && (rr < 12 || rr > 20)) abnormal.push(`Respiratory rate ${rr}/min`);
  if (sbp != null && sbp < 90) abnormal.push(`Systolic BP ${sbp} mmHg`);
  if (spo2 != null && spo2 < 95) abnormal.push(`SpO₂ ${spo2}%`);
  if (temp != null && (temp < 36.1 || temp > 37.2)) abnormal.push(`Temperature ${temp} °C`);
  if (lactate != null && lactate > 2) abnormal.push(`Lactate ${lactate} mmol/L`);
  if (wbc != null && (wbc < 4 || wbc > 11)) abnormal.push(`WBC ${wbc}`);
  if (crp != null && crp > 10) abnormal.push(`CRP ${crp} mg/L`);
  if (abnormal.length) {
    return { level: "abnormal", title: "Abnormal observations — review", reasons: abnormal };
  }
  return { level: "none", title: "No configured trigger", reasons: [] };
}

export function monitorAlert(obs = {}, heartRate = "") {
  const state = reviewState(obs, heartRate);
  if (state.level === "none") return [];
  return state.reasons.filter((reason) => reason !== "Unacknowledged alert");
}

function latestObs(patient) {
  const rows = patient?.observations || [];
  return rows[rows.length - 1] || null;
}

function sexShort(sex) {
  if (sex === "Male") return "M";
  if (sex === "Female") return "F";
  return sex || "";
}

// Demonstration figure from the saved observations. It is not a hospital model score.
export function teachingScore(obs = {}, heartRate = "") {
  const row = { ...obs };
  if (row.hr == null || row.hr === "") row.hr = heartRate;
  const review = reviewState(row, heartRate);
  let points = 0;
  const hr = num(row.hr);
  const rr = num(row.rr);
  const sbp = num(row.sbp);
  const spo2 = num(row.spo2);
  const temp = num(row.temp);
  const lactate = num(row.lactate);
  const wbc = num(row.wbc);
  const crp = num(row.crp);
  if (hr != null) points += Math.min(12, Math.abs(hr - 80) / 4);
  if (rr != null) points += Math.min(14, Math.max(0, rr - 16));
  if (sbp != null && sbp < 110) points += Math.min(10, (110 - sbp) / 4);
  if (spo2 != null) points += Math.min(16, Math.max(0, 96 - spo2));
  if (temp != null) points += Math.min(8, Math.max(0, (temp - 37.2) * 6));
  if (lactate != null) points += Math.min(10, Math.max(0, (lactate - 1.2) * 4));
  if (wbc != null) points += Math.min(8, Math.max(0, wbc - 11));
  if (crp != null) points += Math.min(12, Math.max(0, (crp - 10) / 4));
  let score = 6 + points;
  if (review.level === "urgent") score = Math.max(score, 48);
  if (review.level === "abnormal") score = Math.min(46, Math.max(22, score));
  if (review.level === "none") score = Math.min(score, 18);
  return Math.round(Math.max(4, Math.min(88, score)));
}

function qsofaLabel(review) {
  return review.level === "urgent" ? "ALERT" : "No proxy trigger";
}

function cohortLabel(patient) {
  const obs = latestObs(patient) || {};
  const review = reviewState(obs, patient.heartRate);
  const bits = [sexShort(patient.sex), patient.age ? `Age ${patient.age}` : ""].filter(Boolean);
  const who = bits.length ? ` (${bits.join(", ")})` : "";
  return `${patient.patientId}${who} | Teaching score: ${teachingScore(obs, patient.heartRate)}% | qSOFA: ${qsofaLabel(review)}`;
}

function inCohort(patient, filter) {
  const review = reviewState(latestObs(patient) || {}, patient.heartRate);
  if (filter === "alerts") return review.level === "urgent" || review.level === "abnormal";
  if (filter === "progression") {
    const rows = patient.observations || [];
    if (rows.length < 6) return false;
    return teachingScore(rows[rows.length - 1]) - teachingScore(rows[0]) >= 8;
  }
  return true;
}

const TREND_METRICS = [
  { key: "hr", label: "Heart Rate (bpm)", max: 180, bar: "bg-rose-500", text: "text-rose-700" },
  { key: "rr", label: "Resp Rate (breaths/min)", max: 40, bar: "bg-red-500", text: "text-red-700" },
  { key: "sbp", label: "Systolic BP (mmHg)", max: 200, bar: "bg-sky-600", text: "text-sky-800" },
  { key: "spo2", label: "SpO2 (%)", max: 100, bar: "bg-cyan-500", text: "text-cyan-800" },
  { key: "temp", label: "Temperature (°C)", max: 42, bar: "bg-amber-500", text: "text-amber-800" },
  { key: "lactate", label: "Lactate (mmol/L)", max: 8, bar: "bg-red-600", text: "text-red-800" },
  { key: "crp", label: "CRP (mg/L)", max: 80, bar: "bg-fuchsia-500", text: "text-fuchsia-800" },
  { key: "wbc", label: "WBC (x10^9/L)", max: 20, bar: "bg-lime-500", text: "text-lime-800" },
];

function trendSlots(observations) {
  const series = (observations || []).slice(-12);
  return Array.from({ length: 12 }, (_, i) => series[i] || null);
}

function trendLane(metric, slots, hour, bar = "h-12") {
  const selected = slots[hour];
  const shown = selected ? num(selected[metric.key]) : null;
  return el("div", {},
    el("div", { class: "mb-0.5 flex justify-between gap-2 text-[11px] font-bold text-gray-600" },
      el("span", {}, metric.label),
      el("span", { class: metric.text }, shown == null ? "—" : String(selected[metric.key]))
    ),
    el("div", { class: `flex ${bar} items-end gap-0.5` },
      ...slots.map((row, i) => {
        const n = row ? num(row[metric.key]) : null;
        const pct = n == null ? 8 : Math.max(12, Math.min(100, (n / metric.max) * 100));
        return el("div", {
          class: `min-w-0 flex-1 ${n == null ? "bg-slate-200" : metric.bar} ${i === hour ? "outline outline-1 outline-slate-900" : ""}`,
          style: { height: `${pct}%` },
          title: n == null ? `H+${i} not recorded` : `H+${i} ${n}`,
        });
      })
    )
  );
}

function assessmentPreface(patient, review, stamp, hour, {
  patients = [],
  cohort = "all",
  onCohort,
  onPatient,
  onReturn,
  onEvaluate,
  qaOpen,
  onToggleQa,
  hourScore,
  embedded = false,
}) {
  const urgent = review.level === "urgent";
  const box = urgent
    ? "border-red-300 bg-red-50 text-red-900"
    : "border-amber-300 bg-amber-50 text-amber-950";
  const name = patientDisplayName(patient) || patient.patientId;
  const counts = {
    all: patients.length,
    alerts: patients.filter((row) => inCohort(row, "alerts")).length,
    progression: patients.filter((row) => inCohort(row, "progression")).length,
  };
  const choices = patients.filter((row) => inCohort(row, cohort) || row.patientId === patient.patientId);
  return el("div", { class: "mb-3 space-y-2" },
    el("div", { class: "rounded border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-950" },
      "Latest resulted biomarkers linked to this patient: WBC, Lactate, CRP. Review the lab timestamps before recording a new assessment."
    ),
    el("div", { class: `rounded border px-3 py-2 text-xs ${box}` },
      el("p", { class: "font-bold" },
        "Latest saved assessment: ", review.title,
        stamp ? ` · ${stamp}` : ""
      ),
      ...review.reasons.map((reason) => el("p", {}, reason)),
      el("p", { class: "font-bold" }, "Review and acknowledge alert"),
      el("p", { class: "font-bold" }, "Assessment due under the 4-hour monitoring plan; reassess the patient.")
    ),
    el("p", { class: "text-[11px] leading-relaxed text-gray-600" },
      "Adult teaching screen: the two-criterion proxy omits mental status and is not full qSOFA or NEWS2. Negative screening does not exclude sepsis. The teaching score is calculated from the saved observations on this chart. It is not a hospital deterioration model and not a clinical probability."
    ),
    el("div", { class: "flex flex-wrap items-center justify-between gap-2 rounded bg-sky-100 px-3 py-2 text-xs text-sky-950" },
      el("span", {}, `Historical H+${hour} preview — read-only. The saved current assessment is unchanged.`),
      el("button", { type: "button", class: "font-bold underline", onClick: onReturn }, "Return to latest observations")
    ),
    embedded ? null : el("details", { class: "rounded border border-sky-200 bg-sky-50 text-xs", open: true },
      el("summary", { class: "cursor-pointer px-3 py-2 font-bold text-sky-950" }, "Teaching cases — historical cohort selection and evaluation"),
      el("div", { class: "space-y-2 border-t border-sky-200 px-3 py-2" },
        el("p", {}, `Linked inpatient teaching cohort: ward demonstration charts (${patients.length})`),
        el("div", { class: "flex flex-wrap items-end gap-2" },
          el("label", { class: "flex flex-col gap-1" },
            "Filter",
            el("select", {
              class: INPUT,
              value: cohort,
              onChange: (e) => onCohort?.(e.target.value),
            },
              el("option", { value: "all", selected: cohort === "all" }, `All cases (${counts.all})`),
              el("option", { value: "alerts", selected: cohort === "alerts" }, `Deterioration alerts (${counts.alerts})`),
              el("option", { value: "progression", selected: cohort === "progression" }, `Synthetic teaching cases (${counts.progression})`)
            )
          ),
          el("label", { class: "flex min-w-[22rem] flex-1 flex-col gap-1" },
            "Patient",
            el("select", {
              class: INPUT,
              value: patient.patientId || "",
              onChange: (e) => onPatient?.(e.target.value),
            },
              ...choices.map((row) => el("option", {
                value: row.patientId,
                selected: row.patientId === patient.patientId,
              }, cohortLabel(row)))
            )
          ),
          el("button", { type: "button", class: BTN, onClick: onEvaluate }, "Evaluate selected hour")
        )
      )
    ),
    el("div", { class: "flex flex-wrap items-center justify-between gap-3 rounded border border-gray-300 bg-white px-3 py-2 text-xs" },
      el("div", {},
        el("p", { class: "font-bold text-slate-900" }, name),
        el("p", { class: "text-gray-600" },
          patient.patientId,
          patient.sex ? ` · ${patient.sex}` : "",
          patient.age ? ` · Age ${patient.age}` : ""
        )
      ),
      el("div", { class: "flex flex-wrap items-center gap-3" },
        el("span", {}, "QA outcome ", el("strong", {}, qaOpen ? "Open" : "Sealed")),
        el("span", {}, "Teaching score ", el("strong", {}, hourScore == null ? "—" : `${hourScore}%`)),
        el("span", { class: urgent ? "rounded bg-red-600 px-2 py-0.5 font-bold text-white" : "rounded bg-amber-500 px-2 py-0.5 font-bold text-white" },
          urgent ? "qSOFA proxy ALERT" : "qSOFA proxy"
        ),
        el("button", { type: "button", class: BEVEL, onClick: onToggleQa }, qaOpen ? "Hide QA review mode" : "Reveal QA review mode")
      )
    ),
    qaOpen
      ? el("p", { class: "rounded border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-600" },
          "QA review mode shows the teaching score for the selected hour. The saved assessment is unchanged until you record new vitals."
        )
      : null
  );
}

function scoreLane(slots, hour, bar = "h-12") {
  const selected = slots[hour];
  const shown = selected ? teachingScore(selected) : null;
  return el("div", {},
    el("div", { class: "mb-0.5 flex justify-between gap-2 text-[11px] font-bold text-gray-600" },
      el("span", {}, "Teaching score (%)"),
      el("span", { class: "text-violet-800" }, shown == null ? "—" : `${shown}%`)
    ),
    el("div", { class: `flex ${bar} items-end gap-0.5` },
      ...slots.map((row, i) => {
        const n = row ? teachingScore(row) : null;
        const pct = n == null ? 8 : Math.max(12, Math.min(100, n));
        return el("div", {
          class: `min-w-0 flex-1 ${n == null ? "bg-slate-200" : "bg-violet-500"} ${i === hour ? "outline outline-1 outline-slate-900" : ""}`,
          style: { height: `${pct}%` },
          title: n == null ? `H+${i} not recorded` : `H+${i} ${n}%`,
        });
      })
    )
  );
}

function trendPanel(observations, hour, onHour, patientId, { compact = false, onEvaluate, onReturn } = {}) {
  const slots = trendSlots(observations);
  const saved = (observations || []).slice(-12).length;
  const bar = compact ? "h-6" : "h-12";
  const lanes = TREND_METRICS.map((metric) => trendLane(metric, slots, hour, bar));
  lanes.splice(3, 0, scoreLane(slots, hour, bar));
  return el("section", {
    class: compact
      ? "shrink-0 border border-gray-400 bg-white"
      : "mb-3 border border-gray-400 bg-white",
    "aria-label": "12-hour observation trend",
  },
    el("div", { class: `flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-slate-50 px-3 ${compact ? "py-1" : "py-2"}` },
      el("h3", { class: "text-sm font-bold text-slate-800" }, `12-hour teaching trajectory${patientId ? ` (${patientId})` : ""}`),
      el("span", { class: "flex items-center gap-2 text-xs text-gray-500" },
        saved ? `${saved} of 12 hours saved` : "No hourly series saved yet",
        compact && onReturn ? el("button", { type: "button", class: "font-bold text-sky-900 underline", onClick: onReturn }, "Latest") : null,
        compact && onEvaluate ? el("button", { type: "button", class: "font-bold text-sky-900 underline", onClick: onEvaluate }, "Load hour") : null
      )
    ),
    el("div", { class: `flex flex-wrap items-center gap-1 px-3 text-xs ${compact ? "py-1" : "py-2"}` },
      el("span", { class: "mr-1 font-bold text-gray-600" }, "Select hour"),
      ...slots.map((row, i) => el("button", {
        type: "button",
        class: `min-w-9 rounded px-1.5 py-0.5 text-center font-bold leading-tight ${i === hour ? "bg-slate-900 text-white" : row ? "bg-slate-200 text-slate-800" : "bg-slate-100 text-slate-400"}`,
        onClick: () => onHour(i),
      },
        el("span", { class: "block" }, `H+${i}`),
        compact ? null : el("span", { class: "block text-[10px] font-normal" }, row ? `${teachingScore(row)}%` : "—")
      ))
    ),
    el("div", { class: compact ? "grid grid-cols-4 gap-2 px-3 pb-2" : "grid gap-3 px-3 pb-2 sm:grid-cols-2 xl:grid-cols-4" },
      ...lanes
    ),
    compact ? null : el("p", { class: "px-3 pb-3 text-xs text-gray-500" },
      "Shown only for Abnormal observations — review and Urgent review. Empty hours stay blank until an assessment is saved. Patients on No configured trigger do not use this trend."
    )
  );
}

async function loadPatients() {
  const data = await api.listPatients();
  return data.patients || [];
}

async function loadPatient(id) {
  if (!id) return null;
  const data = await api.getPatient(id);
  return data.patient || null;
}

function patientPicker(patients, selectedId, onChange) {
  return el("select", {
    class: INPUT,
    value: selectedId || "",
    onChange: (e) => onChange(e.target.value),
  },
    el("option", { value: "" }, "Select patient"),
    ...patients.map((p) => el("option", { value: p.patientId }, `${patientDisplayName(p) || p.patientId} · ${p.patientId}`))
  );
}

function openChart(id) {
  state.selectedPatientId = id;
  setPage("patient");
}

export async function renderBedsPage({ target }) {
  let patients = [];
  let error = "";
  let busy = false;
  let patientId = state.selectedPatientId || "";
  let bed = "";
  const canEdit = canEditPatient(state.user);

  async function refresh() {
    patients = await loadPatients();
    if (!patientId && patients[0]) patientId = patients[0].patientId;
    paint();
  }

  async function assign(status) {
    if (!canEdit || !patientId || !bed) {
      toast("Choose a patient and a bed.");
      return;
    }
    const taken = patients.find((p) => p.bed === bed && p.patientId !== patientId && p.admissionStatus !== "discharged");
    if (taken && status !== "discharged") {
      toast(`${bed} is already assigned to ${patientDisplayName(taken) || taken.patientId}.`);
      return;
    }
    busy = true;
    paint();
    try {
      await api.updatePatient(patientId, {
        bed: status === "discharged" ? "" : bed,
        ward: status === "discharged" ? "" : wardOf(bed),
        admissionStatus: status,
      });
      state.selectedPatientId = patientId;
      toast(status === "discharged" ? "Patient discharged from the bed." : `Bed ${bed} updated.`);
      await refresh();
    } catch (err) {
      toast(err.message || "Could not update the bed.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const byBed = new Map(patients.filter((p) => p.bed).map((p) => [p.bed, p]));
    mount(target, el("div", { class: "space-y-2" },
      error ? el("p", { class: "bg-red-100 p-3 text-red-900" }, error) : null,
      frame("Bed Management & Inpatient Admission",
        el("p", { class: "text-sm text-gray-600" }, "Admit, reserve, transfer, or discharge. The X-ray worklist is unchanged."),
        canEdit ? el("div", { class: "mt-3 grid gap-2 md:grid-cols-[1fr_10rem_auto_auto_auto]" },
          patientPicker(patients, patientId, (id) => { patientId = id; state.selectedPatientId = id; }),
          el("select", { class: INPUT, value: bed, onChange: (e) => { bed = e.target.value; } },
            el("option", { value: "" }, "Select bed"),
            ...BEDS.map((id) => el("option", { value: id }, id))
          ),
          el("button", { class: BTN, disabled: busy, onClick: () => assign("admitted") }, "Confirm admission"),
          el("button", { class: "rounded border border-gray-400 bg-white px-3 py-2 text-xs font-bold", disabled: busy, onClick: () => assign("reserved") }, "Reserve"),
          el("button", { class: "rounded border border-red-300 bg-white px-3 py-2 text-xs font-bold text-red-800", disabled: busy, onClick: () => assign("discharged") }, "Discharge")
        ) : el("p", { class: "mt-2 text-sm text-gray-500" }, "This account can view the bed board only."),
        el("div", { class: "mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" },
          ...BEDS.map((id) => {
            const person = byBed.get(id);
            const occupied = person && person.admissionStatus !== "discharged";
            return el("button", {
              type: "button",
              class: `border p-3 text-left ${occupied ? "border-ha-blue bg-blue-50" : "border-gray-300 bg-gray-50"}`,
              onClick: () => {
                bed = id;
                if (person) {
                  patientId = person.patientId;
                  state.selectedPatientId = person.patientId;
                }
                paint();
              },
            },
              el("div", { class: "text-xs font-bold text-gray-500" }, wardOf(id), " · ", id),
              el("div", { class: "mt-1 font-semibold text-slate-900" }, occupied ? (patientDisplayName(person) || person.patientId) : "Available"),
              el("div", { class: "text-xs capitalize text-gray-600" }, occupied ? person.admissionStatus : "Empty")
            );
          })
        )
      )
    ));
  }

  try { await refresh(); }
  catch (err) { error = err.message; paint(); }
}

// `embedded` renders one patient's monitor (no ward worklist) for the
// floating window on the patient chart.
export async function renderMonitorPage({ target, patientId: focusId = "", embedded = false, onSaved } = {}) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = { hr: "", rr: "", sbp: "", spo2: "", temp: "", wbc: "", lactate: "", crp: "" };
  let trendHour = 11;
  let hourNote = "";
  let wardFilter = "all";
  let findQuery = "";
  let showFilter = "all";
  let chooseToken = 0;
  const canEdit = canEditPatient(state.user);

  function controlValue(e) {
    const node = e.target;
    const raw = node?.value;
    const options = [...(node?.options || [])];
    const match = options.find((opt) => (opt.getAttribute("value") ?? opt.value) === raw);
    if (match) return match.getAttribute("value") ?? raw;
    const picked = node?.selectedOptions?.[0]?.getAttribute?.("value");
    return picked != null ? picked : raw;
  }

  async function choose(id) {
    const token = ++chooseToken;
    state.selectedPatientId = id;
    selected = await loadPatient(id);
    if (token !== chooseToken) return;
    if (selected && !patients.some((p) => p.patientId === selected.patientId)) {
      patients = [selected, ...patients];
    }
    const obs = latestObs(selected);
    if (token !== chooseToken) return;
    form.hr = obs?.hr || String(selected?.heartRate || "").replace(/[^\d.]/g, "");
    form.rr = obs?.rr || "";
    form.sbp = obs?.sbp || "";
    form.spo2 = obs?.spo2 || "";
    form.temp = obs?.temp || "";
    form.wbc = obs?.wbc || "";
    form.lactate = obs?.lactate || "";
    form.crp = obs?.crp || "";
    const saved = (selected?.observations || []).length;
    trendHour = Math.min(11, Math.max(0, saved - 1));
    if (token !== chooseToken) return;
    paint();
  }

  // Ward, review, and the name box only change who is in the patient dropdown.
  // If the open chart is no longer in that set, open the first match so the
  // page actually changes.
  function applyFilters() {
    const list = matchingPatients();
    const still = selected && list.some((p) => p.patientId === selected.patientId);
    if (!list.length) {
      chooseToken += 1;
      selected = null;
      state.selectedPatientId = "";
      paint();
      return;
    }
    paint();
    if (!still) choose(list[0].patientId);
  }

  function matchingPatients() {
    const admitted = patients.filter((p) => p.admissionStatus === "admitted" || p.bed);
    const base = admitted.length ? admitted : patients;
    const query = findQuery.trim().toLowerCase();
    return base.filter((p) => {
      if (wardFilter !== "all" && (p.ward || wardOf(p.bed)) !== wardFilter) return false;
      const level = reviewState(latestObs(p) || {}, p.heartRate).level;
      if (showFilter !== "all" && level !== showFilter) return false;
      if (!query) return true;
      const hay = [
        patientDisplayName(p),
        p.name,
        p.firstName,
        p.middleName,
        p.lastName,
        p.patientId,
        p.bed,
        p.ward,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(query);
    }).sort((a, b) => (patientDisplayName(a) || "").localeCompare(patientDisplayName(b) || ""));
  }

  async function saveVitals() {
    if (!canEdit || !selected) return;
    busy = true;
    paint();
    try {
      const row = { ...form, at: new Date().toISOString(), by: state.user?.name || "" };
      const observations = [...(selected.observations || []), row];
      const data = await api.updatePatient(selected.patientId, {
        observations,
        heartRate: form.hr ? `${form.hr} bpm` : selected.heartRate,
      });
      selected = data.patient;
      toast("Vitals recorded.");
      onSaved?.(selected);
    } catch (err) {
      toast(err.message || "Could not record vitals.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const admitted = patients.filter((p) => p.admissionStatus === "admitted" || p.bed);
    const base = admitted.length ? admitted : patients;
    const wards = [...new Set(base.map((p) => p.ward || wardOf(p.bed)).filter(Boolean))].sort();
    const list = matchingPatients();
    const urgentCount = base.filter((p) => reviewState(latestObs(p) || {}, p.heartRate).level === "urgent").length;
    const obsRows = (selected?.observations || []).slice().reverse();
    const choices = list;
    const currentReview = selected ? reviewState(latestObs(selected) || {}, selected.heartRate) : null;
    function returnToLatest() {
      const saved = (selected.observations || []).length;
      trendHour = Math.min(11, Math.max(0, saved - 1));
      const latest = latestObs(selected) || {};
      form.hr = latest.hr || String(selected?.heartRate || "").replace(/[^\d.]/g, "");
      form.rr = latest.rr || "";
      form.sbp = latest.sbp || "";
      form.spo2 = latest.spo2 || "";
      form.temp = latest.temp || "";
      form.wbc = latest.wbc || "";
      form.lactate = latest.lactate || "";
      form.crp = latest.crp || "";
      hourNote = "";
      paint();
    }
    function loadHour() {
      const row = trendSlots(selected.observations)[trendHour];
      if (row) {
        form.hr = row.hr || "";
        form.rr = row.rr || "";
        form.sbp = row.sbp || "";
        form.spo2 = row.spo2 || "";
        form.temp = row.temp || "";
        form.wbc = row.wbc || "";
        form.lactate = row.lactate || "";
        form.crp = row.crp || "";
        hourNote = `H+${trendHour} preview · teaching score ${teachingScore(row)}%. The saved assessment is unchanged until you record new vitals.`;
      } else {
        hourNote = `H+${trendHour} has no saved observation.`;
      }
      paint();
    }
    const vitalFields = (compact) => [
      ["hr", compact ? "Heart rate" : "Heart Rate (bpm)", "Normal 60–100 bpm"],
      ["rr", compact ? "Resp. rate" : "Respiratory Rate (breaths/min)", "Normal 12–20 breaths/min"],
      ["sbp", compact ? "Systolic BP" : "Systolic BP (mmHg)", "Normal 90–120 mmHg"],
      ["spo2", compact ? "SpO2" : "SpO2 (%)", "Normal 95–100 %"],
      ["temp", compact ? "Temperature" : "Temperature (°C)", "Normal 36.1–37.2 °C"],
      ["wbc", compact ? "WBC" : "WBC (x10^9/L)", "Normal 4–11"],
      ["lactate", compact ? "Lactate" : "Lactate (mmol/L)", "Normal 0.5–2 mmol/L"],
      ["crp", compact ? "CRP" : "CRP Level (mg/L)", "Normal 0–10 mg/L"],
    ].map(([key, label, hint]) => el("div", {},
      el("label", { class: "text-[11px] font-bold", title: hint }, label),
      compact ? null : el("div", { class: "text-[10px] text-gray-500" }, hint),
      el("input", {
        id: key === "hr" ? "sepsis-hr" : undefined,
        class: compact
          ? "mt-0.5 w-full border border-gray-500 bg-white px-1.5 py-0.5 text-right text-sm"
          : "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-right",
        title: hint,
        disabled: !canEdit,
        value: form[key],
        onInput: (e) => { form[key] = e.target.value; },
      })
    ));
    const flowsheet = el("div", { class: "flex min-h-0 flex-1 flex-col overflow-hidden border border-gray-400 bg-white" },
      el("div", { class: "flex shrink-0 justify-between bg-[#008080] px-2 py-1 text-xs font-bold text-white" },
        el("span", {}, "Vitals Flowsheet & Alert Audit Log"),
        el("span", {}, `Total Evaluations: ${obsRows.length}`)
      ),
      el("div", { class: "min-h-0 flex-1 overflow-auto" },
        obsRows.length
          ? el("table", { class: "w-full border-collapse text-center text-xs" },
              el("thead", {},
                el("tr", { class: "border-b border-gray-400 bg-gray-200" },
                  ["Time", "Source", "HR", "RR", "BP", "SpO2", "Temp", "WBC", "Lactate", "CRP", "Teaching score", "QA", "System Alert"].map((h) =>
                    el("th", { class: "border-r border-gray-400 p-1.5" }, h)
                  )
                )
              ),
              el("tbody", {},
                ...obsRows.map((row, index) => {
                  const review = reviewState(row, row.hr);
                  const flagged = review.level !== "none";
                  const hour = obsRows.length - 1 - index;
                  return el("tr", { class: `border-b border-gray-300 ${review.level === "urgent" ? "bg-red-50 text-red-900" : flagged ? "bg-amber-50 text-amber-900" : ""}` },
                    el("td", { class: "border-r border-gray-400 p-1.5" }, cmsAssessmentStamp(row.at) || "—"),
                    el("td", { class: "border-r border-gray-400 p-1.5" }, row.by ? `${row.by} · H+${hour}` : `H+${hour}`),
                    el("td", { class: "border-r border-gray-400 p-1.5" }, row.hr || "—"),
                    el("td", { class: "border-r border-gray-400 p-1.5" }, row.rr || "—"),
                    el("td", { class: "border-r border-gray-400 p-1.5" }, row.sbp || "—"),
                    el("td", { class: "border-r border-gray-400 p-1.5" }, row.spo2 ? `${row.spo2}%` : "—"),
                    el("td", { class: "border-r p-1.5" }, row.temp || "—"),
                    el("td", { class: "border-r p-1.5" }, row.wbc || "—"),
                    el("td", { class: "border-r p-1.5" }, row.lactate || "—"),
                    el("td", { class: "border-r p-1.5" }, row.crp || "—"),
                    el("td", { class: "border-r p-1.5" }, `${teachingScore(row)}%`),
                    el("td", { class: "border-r p-1.5" }, "Sealed"),
                    el("td", { class: "p-1.5" }, review.level === "urgent" ? "TRIGGERED" : flagged ? "Review" : "—")
                  );
                })
              )
            )
          : el("p", { class: "p-4 text-sm text-gray-500" }, "No saved observations for this patient.")
      )
    );
    const wrap = (...body) => el("div", { class: "flex h-full min-h-0 flex-1 flex-col overflow-hidden" },
          el("div", { class: "relative flex h-full min-h-0 flex-col overflow-hidden border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-1.5 shadow-sm" },
            el("div", { class: "flex shrink-0 items-center gap-2 border-b border-[#d9d3bc] bg-ha-paper px-2 py-1 text-sm font-bold text-stone-900" },
              "Inpatient Observations & Sepsis Screening (Teaching)"
            ),
            el("div", { class: "flex min-h-0 flex-1 flex-col overflow-hidden" }, ...body)
          )
        );
    mount(target, wrap(
      error ? el("p", { class: "mt-1 shrink-0 bg-red-100 p-2 text-sm text-red-900" }, error) : null,
      el("div", { class: "mt-1 grid shrink-0 grid-cols-2 items-end gap-2 text-xs lg:grid-cols-[9rem_13rem_11rem_minmax(0,1fr)]" },
        el("label", { class: "flex flex-col gap-0.5" },
          "Ward",
          el("select", {
            id: "sepsis-ward",
            class: INPUT,
            value: wardFilter,
            onChange: (e) => { wardFilter = controlValue(e); applyFilters(); },
          },
            el("option", { value: "all", selected: wardFilter === "all" }, "All wards"),
            ...wards.map((ward) => el("option", { value: ward, selected: wardFilter === ward }, ward))
          )
        ),
        el("label", { class: "flex flex-col gap-0.5" },
          "Review",
          el("select", {
            id: "sepsis-review",
            class: INPUT,
            value: showFilter,
            onChange: (e) => { showFilter = controlValue(e); applyFilters(); },
          },
            el("option", { value: "all", selected: showFilter === "all" }, "All inpatients"),
            el("option", { value: "urgent", selected: showFilter === "urgent" }, `Urgent review (${urgentCount})`),
            el("option", { value: "abnormal", selected: showFilter === "abnormal" }, "Abnormal observations"),
            el("option", { value: "none", selected: showFilter === "none" }, "No configured trigger")
          )
        ),
        el("label", { class: "flex flex-col gap-0.5" },
          "Filter",
          el("input", {
            id: "sepsis-find",
            class: INPUT,
            placeholder: "Name or number",
            value: findQuery,
            onInput: (e) => { findQuery = e.target.value; applyFilters(); },
          })
        ),
        el("label", { class: "flex min-w-0 flex-col gap-0.5" },
          `Patient (${choices.length})`,
          el("select", {
            id: "sepsis-patient",
            class: INPUT,
            value: choices.some((p) => p.patientId === selected?.patientId) ? selected.patientId : "",
            onChange: (e) => { const id = controlValue(e); if (id) choose(id); },
          },
            el("option", { value: "" }, choices.length ? "Select a patient" : "No patients match"),
            ...choices.map((p) => el("option", {
              value: p.patientId,
              selected: p.patientId === selected?.patientId,
            }, `${patientDisplayName(p) || p.patientId} · ${p.patientId}${p.bed ? ` · ${p.bed}` : ""}`))
          )
        )
      ),
      activePatientBar(selected, { compact: true }),
      selected
        ? el("div", { class: "mt-1 grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] gap-2 overflow-hidden" },
            el("div", { class: "flex min-h-0 flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-2" },
              el("h3", { class: "mb-2 flex items-center justify-between border-b border-gray-400 pb-1 text-sm font-bold text-ha-blue" },
                el("span", {}, "Enter / Update Vitals"),
                el("span", { class: "rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-normal text-blue-800" }, "New assessment")
              ),
              el("div", { class: "grid grid-cols-2 gap-x-2 gap-y-1" },
                ...vitalFields(true),
                canEdit && el("button", {
                  class: `${BEVEL} col-span-2 mt-1 px-2 py-1`,
                  disabled: busy,
                  onClick: saveVitals,
                }, "Record Vitals & Run Clinical Evaluation")
              )
            ),
            el("div", { class: "flex min-h-0 flex-col gap-1 overflow-hidden" },
              currentReview && currentReview.level !== "none"
                ? el("p", {
                    class: `shrink-0 rounded border px-2 py-1 text-xs ${currentReview.level === "urgent" ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-950"}`,
                  },
                    el("strong", {}, currentReview.title),
                    cmsAssessmentStamp(latestObs(selected)?.at) ? ` · ${cmsAssessmentStamp(latestObs(selected)?.at)}` : "",
                    currentReview.reasons.length ? ` · ${currentReview.reasons.join("; ")}` : ""
                  )
                : null,
              currentReview && currentReview.level !== "none"
                ? trendPanel(
                    selected.observations,
                    trendHour,
                    (hour) => { trendHour = hour; hourNote = ""; paint(); },
                    selected.patientId,
                    { compact: true, onEvaluate: loadHour, onReturn: returnToLatest }
                  )
                : null,
              hourNote ? el("p", { class: "shrink-0 text-xs font-bold text-sky-900" }, hourNote) : null,
              flowsheet
            )
          )
        : el("p", { class: "mt-3 text-sm text-slate-600" }, "Choose a patient.")
    ));
  }

  try {
    try { patients = await loadPatients(); } catch { patients = []; }
    const id = focusId || state.selectedPatientId;
    if (id) await choose(id);
    else paint();
  } catch (err) {
    error = err.message;
    paint();
  }
}

export async function renderLabsPage({ target }) {
  await renderListModule(target, {
    title: "Lab Orders & Results",
    formTitle: "New Lab Order",
    saveLabel: "Place Lab Order",
    listTitle: "Current Patient Worklist",
    hint: "Orders stay on the chart. The latest result is also shown as the patient lab summary.",
    field: "labOrders",
    empty: "No lab orders for this patient.",
    columns: [
      ["panel", "Test"],
      ["priority", "Priority"],
      ["status", "Status"],
      ["result", "Result"],
    ],
    build(form) {
      return {
        at: new Date().toISOString(),
        panel: form.panel,
        priority: form.priority,
        notes: form.notes,
        status: form.result ? "resulted" : "ordered",
        result: form.result,
      };
    },
    extraPatch(rows) {
      const last = [...rows].reverse().find((row) => row.result);
      return last ? { labResults: `${last.panel}: ${last.result}` } : {};
    },
    formFields: [
      ["panel", "Test panel", "select", ["CBC", "CRP", "Lactate", "Renal panel"]],
      ["priority", "Priority", "select", ["Routine", "Urgent", "STAT"]],
      ["notes", "Clinical notes", "text"],
      ["result", "Result", "text"],
    ],
    canEdit: () => canArrangeLab(state.user),
  });
}

const NOTE_ROLES = ["RN (Registered Nurse)", "Radiologist", "Doctor", "Technician"];
const NOTE_CATEGORIES = ["General", "Handover", "Incident", "Pain Assessment", "Wound Care"];

// `embedded` renders one patient's notes for the separate chart window.
export async function renderNotesPage({ target, patientId: focusId = "", embedded = false, onSaved } = {}) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = {
    author: state.user?.name || "",
    role: "RN (Registered Nurse)",
    category: "General",
    note: "",
  };
  const canEdit = canEditPatient(state.user);

  async function choose(id) {
    state.selectedPatientId = id;
    selected = id ? await loadPatient(id) : null;
    paint();
  }

  async function addRow() {
    if (!canEdit || !selected) return;
    if (!String(form.author || "").trim() || !String(form.note || "").trim()) {
      toast("Enter the author and the note.");
      return;
    }
    busy = true;
    paint();
    try {
      const row = {
        at: new Date().toISOString(),
        author: form.author.trim(),
        role: form.role,
        category: form.category,
        note: form.note.trim(),
      };
      const rows = [...(selected.careNotes || []), row];
      const data = await api.updatePatient(selected.patientId, { careNotes: rows, remarks: row.note });
      selected = data.patient;
      form.note = "";
      toast("Note added to the chart.");
      onSaved?.(selected);
    } catch (err) {
      toast(err.message || "Could not save.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const rows = selected?.careNotes || [];
    const wrap = embedded
      ? (...body) => el("div", { class: "flex h-full min-h-0 flex-col overflow-auto p-2" }, ...body)
      : (...body) => cmsWindow("Nursing / Care Notes (Multidisciplinary Progress Notes)", ...body);
    mount(target, wrap(
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm" }, error) : null,
      activePatientBar(selected),
      embedded ? null : el("div", { class: "mb-2 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs" },
        el("span", {}, "Select inpatient record:"),
        el("div", { class: "min-w-[16rem] flex-1" }, patientPicker(patients, selected?.patientId || "", choose))
      ),
      el("div", { class: embedded ? "flex flex-col gap-3" : "flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row" },
        canEdit && el("div", { class: embedded ? "flex flex-col border border-gray-400 bg-[#e4e4e4] p-3" : "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
          el("h3", { class: "mb-3 border-b border-gray-400 pb-1 font-bold text-ha-blue" }, "New Progress Note"),
          el("label", { class: "text-xs font-bold" }, "Author name / staff ID",
            el("input", {
              class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
              placeholder: "e.g. RN CHAN",
              value: form.author,
              onInput: (e) => { form.author = e.target.value; },
            })
          ),
          el("div", { class: "mt-2 grid grid-cols-2 gap-2" },
            el("label", { class: "text-xs font-bold" }, "Role",
              el("select", {
                class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
                value: form.role,
                onChange: (e) => { form.role = e.target.value; },
              }, ...NOTE_ROLES.map((option) => el("option", { value: option }, option)))
            ),
            el("label", { class: "text-xs font-bold" }, "Category",
              el("select", {
                class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
                value: form.category,
                onChange: (e) => { form.category = e.target.value; },
              }, ...NOTE_CATEGORIES.map((option) => el("option", { value: option }, option)))
            )
          ),
          el("label", { class: "mt-2 block text-xs font-bold" }, "Note",
            el("textarea", {
              class: "mt-1 h-28 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
              placeholder: "Free-text clinical narrative...",
              value: form.note,
              onInput: (e) => { form.note = e.target.value; },
            })
          ),
          el("button", { class: `${BEVEL} mt-3 w-full`, disabled: busy, onClick: addRow }, busy ? "Saving…" : "+ Add Note to Chart"),
          el("p", { class: "mt-3 border border-gray-400 bg-gray-200 p-2 text-[11px] leading-tight text-gray-700" },
            "The note stays on this chart. It is not copied into the X-ray report."
          )
        ),
        el("div", { class: "flex flex-1 flex-col overflow-auto border border-gray-400 bg-white" },
          el("div", { class: "bg-[#008080] px-2 py-1 text-xs font-bold text-white" }, `Current Patient Notes (${rows.length})`),
          rows.length
            ? el("div", { class: "divide-y" }, ...rows.slice().reverse().map((row) => el("article", { class: "p-3 text-xs" },
                el("p", { class: "font-bold text-slate-900" }, row.author || "—", " · ", row.role || ""),
                el("p", { class: "text-gray-500" }, [row.category, cmsAssessmentStamp(row.at)].filter(Boolean).join(" · ")),
                el("p", { class: "mt-1 whitespace-pre-wrap" }, row.note || "—")
              )))
            : el("div", { class: "p-8 text-center text-sm text-gray-500" }, "No progress notes recorded for this patient.")
        )
      )
    ));
  }

  try {
    if (embedded) {
      await choose(focusId);
      return;
    }
    patients = await loadPatients();
    form.author = form.author || state.user?.name || "";
    await choose(state.selectedPatientId || patients[0]?.patientId || "");
  } catch (err) {
    error = err.message;
    paint();
  }
}

async function renderListModule(target, spec) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = {};
  for (const [key, , kind, options] of spec.formFields) {
    form[key] = kind === "select" ? options[0] : "";
  }
  const canEdit = typeof spec.canEdit === "function" ? spec.canEdit() : canEditPatient(state.user);

  async function choose(id) {
    state.selectedPatientId = id;
    selected = id ? await loadPatient(id) : null;
    paint();
  }

  async function addRow() {
    if (!canEdit || !selected) return;
    const row = spec.build(form);
    const missing = spec.formFields.some(([key, , kind]) => (
      kind === "text" && key !== "result" && key !== "notes" && !String(form[key] || "").trim()
    ));
    if (missing) {
      toast("Complete the form before saving.");
      return;
    }
    busy = true;
    paint();
    try {
      const rows = [...(selected[spec.field] || []), row];
      const data = await api.updatePatient(selected.patientId, {
        [spec.field]: rows,
        ...spec.extraPatch(rows, selected),
      });
      selected = data.patient;
      toast("Saved on the patient chart.");
    } catch (err) {
      toast(err.message || "Could not save.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const rows = selected?.[spec.field] || [];
    mount(target, cmsWindow(spec.title,
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm" }, error) : null,
      activePatientBar(selected),
      el("div", { class: "mb-2 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-800" },
        el("span", {}, "Select inpatient record:"),
        el("div", { class: "min-w-[16rem] flex-1" }, patientPicker(patients, selected?.patientId || "", choose))
      ),
      el("div", { class: "flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row" },
        canEdit && el("div", { class: "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
          el("h3", { class: "mb-3 border-b border-gray-400 pb-1 font-bold text-ha-blue" }, spec.formTitle || "New entry"),
          el("div", { class: "flex flex-col gap-2" },
            ...spec.formFields.map(([key, label, kind, options]) => el("label", { class: "text-xs font-bold" },
              label,
              kind === "select"
                ? el("select", { class: "mt-1 w-full rounded border border-gray-400 bg-white px-2 py-1 text-xs", value: form[key], onChange: (e) => { form[key] = e.target.value; } },
                    ...options.map((option) => el("option", { value: option }, option)))
                : kind === "textarea"
                  ? el("textarea", { class: "mt-1 h-28 w-full rounded border border-gray-400 bg-white px-2 py-1 text-xs", onInput: (e) => { form[key] = e.target.value; } }, form[key])
                  : el("input", { class: "mt-1 w-full rounded border border-gray-400 bg-white px-2 py-1 text-xs", value: form[key], onInput: (e) => { form[key] = e.target.value; } })
            )),
            el("button", { class: `${BEVEL} mt-2 flex items-center justify-center px-4 py-2`, disabled: busy, onClick: addRow }, busy ? "Saving…" : (spec.saveLabel || "Save"))
          ),
          el("p", { class: "mt-2 border border-gray-400 bg-gray-200 p-2 text-[11px] leading-tight text-gray-700" }, spec.hint)
        ),
        el("div", { class: "flex flex-1 flex-col overflow-auto border border-gray-400 bg-white" },
          el("div", { class: "bg-[#008080] px-2 py-1 text-xs font-bold text-white" }, `${spec.listTitle || "Current records"} (${rows.length})`),
          rows.length
            ? el("div", { class: "divide-y divide-gray-200" },
                ...rows.slice().reverse().map((row) => el("div", { class: "p-2 text-xs" },
                  spec.columns.map(([key, label]) => el("div", {},
                    el("span", { class: "font-bold text-gray-500" }, label, ": "),
                    row[key] || "—"
                  ))
                ))
              )
            : el("div", { class: "p-8 text-center text-sm text-gray-500" }, spec.empty)
        )
      )
    ));
  }

  try {
    patients = await loadPatients();
    await choose(state.selectedPatientId || patients[0]?.patientId || "");
  } catch (err) {
    error = err.message;
    paint();
  }
}
