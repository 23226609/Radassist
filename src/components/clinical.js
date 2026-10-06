// Inpatient modules in the COMP4126 CMS layout.
// Patient identity and X-ray cases stay on the existing API.
// Ward, vitals, labs, medicines, and care notes are stored on the patient chart.

import { el, mount } from "../dom.js";
import { api } from "../api.js";
import { state, setPage, toast } from "../state.js";
import { patientDisplayName } from "../lib/tags.js";
import { canEditPatient, canArrangeLab, canPrescribe } from "../lib/roles.js";

const BEDS = ["4A-01", "4A-02", "4A-03", "4A-04", "4B-01", "4B-02", "4B-03", "4B-04"];
const INPUT = "w-full rounded border border-gray-400 bg-white px-2 py-1.5 text-sm outline-none focus:border-ha-blue focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100";
const BTN = "rounded bg-ha-blue px-3 py-2 text-xs font-bold text-white hover:bg-[#074f85] disabled:opacity-40";

function cmsWindow(title, ...body) {
  return el("div", { class: "flex h-full min-h-[70vh] flex-col p-2" },
    el("div", { class: "relative flex h-full flex-col border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-2 shadow-sm" },
      el("div", { class: "flex items-center gap-2 bg-ha-blue px-2 py-1 text-sm font-bold text-white" }, title),
      ...body
    )
  );
}

function activePatientBar(patient) {
  if (!patient) return null;
  const where = [patient.ward, patient.bed].filter(Boolean).join(" ");
  return el("div", { class: "my-2 flex justify-between border border-gray-400 bg-[#ffffcc] p-2 text-sm font-bold" },
    el("span", {}, `Active Patient: ${patientDisplayName(patient) || patient.patientId} (${patient.patientId})`),
    el("span", {}, where ? `Location: ${where}` : "Location: not admitted")
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

function trendLane(metric, slots, hour) {
  const selected = slots[hour];
  const shown = selected ? num(selected[metric.key]) : null;
  return el("div", {},
    el("div", { class: "mb-1 flex justify-between gap-2 text-[11px] font-bold text-gray-600" },
      el("span", {}, metric.label),
      el("span", { class: metric.text }, shown == null ? "—" : String(selected[metric.key]))
    ),
    el("div", { class: "flex h-12 items-end gap-0.5" },
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

function assessmentPreface(patient, review, stamp, hour, { onReturn, onEvaluate, qaOpen, onToggleQa }) {
  const urgent = review.level === "urgent";
  const box = urgent
    ? "border-red-300 bg-red-50 text-red-900"
    : "border-amber-300 bg-amber-50 text-amber-950";
  const name = patientDisplayName(patient) || patient.patientId;
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
      "Adult teaching screen: the two-criterion proxy omits mental status and is not full qSOFA or NEWS2. Negative screening does not exclude sepsis. Dataset scores are historical model outputs, not recalculated clinical probabilities. The source outcome is deterioration within 12 hours, not adjudicated sepsis."
    ),
    el("div", { class: "flex flex-wrap items-center justify-between gap-2 rounded bg-sky-100 px-3 py-2 text-xs text-sky-950" },
      el("span", {}, `Historical H+${hour} preview — read-only. The saved current assessment is unchanged.`),
      el("button", { type: "button", class: "font-bold underline", onClick: onReturn }, "Return to latest observations")
    ),
    el("details", { class: "rounded border border-sky-200 bg-sky-50 text-xs", open: true },
      el("summary", { class: "cursor-pointer px-3 py-2 font-bold text-sky-950" }, "Teaching cases — historical cohort selection and evaluation"),
      el("div", { class: "space-y-2 border-t border-sky-200 px-3 py-2" },
        el("p", {}, "Linked inpatient teaching cohort: not loaded"),
        el("div", { class: "flex flex-wrap items-end gap-2" },
          el("label", { class: "flex flex-col gap-1" },
            "Filter",
            el("select", { class: INPUT, disabled: true },
              el("option", {}, "All current inpatients")
            )
          ),
          el("label", { class: "flex min-w-[14rem] flex-col gap-1" },
            "Patient",
            el("input", {
              class: INPUT,
              readOnly: true,
              value: `${name} (${patient.patientId})${patient.sex ? ` ${patient.sex}` : ""}${patient.age ? `, Age ${patient.age}` : ""}`,
            })
          ),
          el("label", { class: "flex flex-col gap-1" },
            "Dataset score",
            el("input", { class: `${INPUT} w-28`, readOnly: true, value: "—" })
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
        el("span", {}, "QA outcome ", el("strong", {}, "Not loaded")),
        el("span", {}, "Historical dataset score ", el("strong", {}, "—")),
        el("span", { class: urgent ? "rounded bg-red-600 px-2 py-0.5 font-bold text-white" : "rounded bg-amber-500 px-2 py-0.5 font-bold text-white" },
          urgent ? "qSOFA proxy ALERT" : "qSOFA proxy"
        ),
        el("button", { type: "button", class: BEVEL, onClick: onToggleQa }, qaOpen ? "Hide QA review mode" : "Reveal QA review mode")
      )
    ),
    qaOpen
      ? el("p", { class: "rounded border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-600" },
          "QA review mode is layout only. No historical dataset score is loaded, and the saved assessment is unchanged."
        )
      : null
  );
}

function trendPanel(observations, hour, onHour) {
  const slots = trendSlots(observations);
  const saved = (observations || []).slice(-12).length;
  return el("section", { class: "mb-3 border border-gray-400 bg-white", "aria-label": "12-hour observation trend" },
    el("div", { class: "flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-slate-50 px-3 py-2" },
      el("h3", { class: "text-sm font-bold text-slate-800" }, "12-hour observation trend"),
      el("span", { class: "text-xs text-gray-500" }, saved ? `${saved} of 12 hours saved` : "No hourly series saved yet")
    ),
    el("div", { class: "flex flex-wrap items-center gap-1 px-3 py-2 text-xs" },
      el("span", { class: "mr-1 font-bold text-gray-600" }, "Select hour"),
      ...slots.map((row, i) => el("button", {
        type: "button",
        class: `min-w-9 rounded px-2 py-1 font-bold ${i === hour ? "bg-slate-900 text-white" : row ? "bg-slate-200 text-slate-800" : "bg-slate-100 text-slate-400"}`,
        onClick: () => onHour(i),
      }, `H+${i}`))
    ),
    el("div", { class: "grid gap-3 px-3 pb-2 sm:grid-cols-2 xl:grid-cols-4" },
      ...TREND_METRICS.map((metric) => trendLane(metric, slots, hour))
    ),
    el("p", { class: "px-3 pb-3 text-xs text-gray-500" },
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

export async function renderMonitorPage({ target }) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = { hr: "", rr: "", sbp: "", spo2: "", temp: "", wbc: "", lactate: "", crp: "" };
  let trendHour = 11;
  let qaOpen = false;
  let hourNote = "";
  const canEdit = canEditPatient(state.user);

  async function choose(id) {
    state.selectedPatientId = id;
    selected = await loadPatient(id);
    const obs = latestObs(selected);
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
    paint();
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
    } catch (err) {
      toast(err.message || "Could not record vitals.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const admitted = patients.filter((p) => p.admissionStatus === "admitted" || p.bed);
    const list = (admitted.length ? admitted : patients);
    const urgentCount = list.filter((p) => reviewState(latestObs(p) || {}, p.heartRate).level === "urgent").length;
    const obsRows = (selected?.observations || []).slice().reverse();
    mount(target, cmsWindow("Inpatient Observations & Sepsis Screening (Teaching)",
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm text-red-900" }, error) : null,
      activePatientBar(selected),
      el("section", { class: "my-3 rounded border border-slate-300 bg-white", "aria-label": "Ward patient worklist" },
        el("div", { class: "flex flex-wrap justify-between gap-2 rounded-t bg-slate-800 px-3 py-2 text-white" },
          el("h2", { class: "font-bold" }, "Ward patient worklist"),
          el("span", { class: "text-xs" }, `${list.length} inpatients · ${urgentCount} require urgent review`)
        ),
        el("div", { class: "max-h-80 overflow-auto" },
          el("table", { class: "w-full min-w-[680px] text-left text-xs" },
            el("thead", { class: "sticky top-0 bg-slate-100" },
              el("tr", {}, ["Ward / bed", "Patient identity", "Latest observations", "Review / next assessment", "Action"].map((h) =>
                el("th", { class: "p-2" }, h)
              ))
            ),
            el("tbody", {},
              ...list.map((p) => {
                const obs = latestObs(p) || {};
                const review = reviewState(obs, p.heartRate);
                const stamp = cmsAssessmentStamp(obs.at);
                const tone = review.level === "urgent"
                  ? "text-red-700"
                  : review.level === "abnormal"
                    ? "text-orange-700"
                    : "text-stone-700";
                const selectedRow = selected?.patientId === p.patientId;
                const obsLine = [
                  obs.hr || num(p.heartRate) != null ? `HR ${obs.hr || num(p.heartRate)}` : "",
                  obs.rr ? `RR ${obs.rr}/min` : "",
                ].filter(Boolean).join(" · ");
                const obsLine2 = [
                  obs.sbp ? `BP ${obs.sbp}${obs.dbp ? `/${obs.dbp}` : ""} mmHg` : "",
                  obs.spo2 ? `SpO₂ ${obs.spo2}%` : "",
                ].filter(Boolean).join(" · ");
                return el("tr", {
                  class: `border-t ${review.level === "urgent" ? "bg-red-50" : review.level === "abnormal" ? "bg-amber-50" : ""} ${selectedRow ? "outline outline-2 -outline-offset-2 outline-blue-600" : ""}`,
                  "aria-selected": selectedRow ? "true" : "false",
                },
                  el("td", { class: "p-2 font-semibold" }, p.ward || "—", el("br"), p.bed || "No bed"),
                  el("td", { class: "p-2" },
                    el("strong", {}, `${p.patientId} · ${patientDisplayName(p) || ""}`),
                    el("br"),
                    [p.age && `${p.age}y`, p.sex].filter(Boolean).join(" · ")
                  ),
                  el("td", { class: "p-2" },
                    obsLine || obsLine2
                      ? el("span", {}, obsLine, obsLine && obsLine2 ? el("br") : null, obsLine2)
                      : (p.heartRate || "No observations")
                  ),
                  el("td", { class: "p-2" },
                    el("strong", { class: tone }, review.title),
                    ...review.reasons.map((reason) => el("div", { class: `mt-0.5 ${tone}` }, reason)),
                    stamp ? el("div", { class: "mt-1 text-stone-600" }, "Assessment due: ", stamp) : null
                  ),
                  el("td", { class: "p-2" },
                    el("button", {
                      class: "rounded border border-blue-600 bg-white px-2 py-2 font-semibold text-blue-800",
                      onClick: () => choose(p.patientId),
                    }, "Open assessment")
                  )
                );
              })
            )
          )
        )
      ),
      selected && reviewState(latestObs(selected) || {}, selected.heartRate).level !== "none"
        ? el("div", {},
            assessmentPreface(
              selected,
              reviewState(latestObs(selected) || {}, selected.heartRate),
              cmsAssessmentStamp(latestObs(selected)?.at),
              trendHour,
              {
                onReturn: () => {
                  const saved = (selected.observations || []).length;
                  trendHour = Math.min(11, Math.max(0, saved - 1));
                  hourNote = "";
                  paint();
                },
                onEvaluate: () => {
                  hourNote = `H+${trendHour} is a read-only preview. The saved assessment is unchanged.`;
                  paint();
                },
                qaOpen,
                onToggleQa: () => { qaOpen = !qaOpen; paint(); },
              }
            ),
            hourNote ? el("p", { class: "mb-2 text-xs font-bold text-sky-900" }, hourNote) : null,
            trendPanel(selected.observations, trendHour, (hour) => { trendHour = hour; hourNote = ""; paint(); })
          )
        : null,
      selected && el("div", { class: "flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row" },
        el("div", { class: "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
          el("h3", { class: "mb-3 flex items-center justify-between border-b border-gray-400 pb-1 font-bold text-ha-blue" },
            el("span", {}, "Enter / Update Vitals"),
            el("span", { class: "rounded bg-blue-100 px-1.5 py-0.5 text-xs font-normal text-blue-800" }, "New assessment")
          ),
          el("div", { class: "flex flex-col gap-3" },
            ...[
              ["hr", "Heart Rate (bpm)", "Normal 60–100 bpm"],
              ["rr", "Respiratory Rate (breaths/min)", "Normal 12–20 breaths/min"],
              ["sbp", "Systolic BP (mmHg)", "Normal 90–120 mmHg"],
              ["spo2", "SpO2 (%)", "Normal 95–100 %"],
              ["temp", "Temperature (°C)", "Normal 36.1–37.2 °C"],
              ["wbc", "WBC (x10^9/L)", "Normal 4–11"],
              ["lactate", "Lactate (mmol/L)", "Normal 0.5–2 mmol/L"],
              ["crp", "CRP Level (mg/L)", "Normal 0–10 mg/L"],
            ].map(([key, label, hint]) => el("div", {},
              el("label", { class: "text-xs font-bold" }, label),
              el("div", { class: "text-[10px] text-gray-500" }, hint),
              el("input", {
                class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-right",
                disabled: !canEdit,
                value: form[key],
                onInput: (e) => { form[key] = e.target.value; },
              })
            )),
            canEdit && el("button", { class: `${BEVEL} mt-2 px-4 py-2`, disabled: busy, onClick: saveVitals }, "Record Vitals & Run Clinical Evaluation")
          )
        ),
        el("div", { class: "flex flex-1 flex-col overflow-auto border border-gray-400 bg-white" },
          el("div", { class: "flex justify-between bg-[#008080] px-2 py-1 text-xs font-bold text-white" },
            el("span", {}, "Vitals Flowsheet & Alert Audit Log"),
            el("span", {}, `Total Evaluations: ${obsRows.length}`)
          ),
          obsRows.length
            ? el("table", { class: "w-full border-collapse text-center text-xs" },
                el("thead", {},
                  el("tr", { class: "border-b border-gray-400 bg-gray-200" },
                    ["Time", "Source", "HR", "RR", "BP", "SpO2", "Temp", "WBC", "Lactate", "CRP", "System Alert"].map((h) =>
                      el("th", { class: "border-r border-gray-400 p-1.5" }, h)
                    )
                  )
                ),
                el("tbody", {},
                  ...obsRows.map((row) => {
                    const review = reviewState(row, row.hr);
                    const flagged = review.level !== "none";
                    return el("tr", { class: `border-b border-gray-300 ${review.level === "urgent" ? "bg-red-50 text-red-900" : flagged ? "bg-amber-50 text-amber-900" : ""}` },
                      el("td", { class: "border-r border-gray-400 p-1.5" }, cmsAssessmentStamp(row.at) || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.by || "Recorded assessment"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.hr || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.rr || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.sbp || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.spo2 ? `${row.spo2}%` : "—"),
                      el("td", { class: "border-r p-1.5" }, row.temp || "—"),
                      el("td", { class: "border-r p-1.5" }, row.wbc || "—"),
                      el("td", { class: "border-r p-1.5" }, row.lactate || "—"),
                      el("td", { class: "border-r p-1.5" }, row.crp || "—"),
                      el("td", { class: "p-1.5" }, review.level === "urgent" ? "TRIGGERED" : flagged ? "Review" : "—")
                    );
                  })
                )
              )
            : el("p", { class: "p-4 text-sm text-gray-500" }, "No saved observations for this patient.")
        )
      )
    ));
  }

  try {
    patients = await loadPatients();
    if (state.selectedPatientId) await choose(state.selectedPatientId);
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

const FORMULARY = [
  { label: "Paracetamol · 1 g tablet", route: "Oral", perDose: "1 stock item per dose", stock: "240" },
  { label: "Amoxicillin · 500 mg capsule", route: "Oral", perDose: "1 stock item per dose", stock: "120" },
  { label: "Salbutamol inhaler", route: "Inhaled", perDose: "2 stock items per dose", stock: "18" },
];
const NOTE_ROLES = ["RN (Registered Nurse)", "Radiologist", "Doctor", "Technician"];
const NOTE_CATEGORIES = ["General", "Handover", "Incident", "Pain Assessment", "Wound Care"];
const DOSE_FREQ = ["OD", "BD", "TDS", "QID", "PRN", "STAT"];

export async function renderMedsPage({ target }) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = {
    drug: FORMULARY[0].label,
    dose: "1",
    frequency: "OD",
    prescribedBy: state.user?.name || "",
    allergyAck: false,
  };
  const canEdit = canPrescribe(state.user);

  async function choose(id) {
    state.selectedPatientId = id;
    selected = id ? await loadPatient(id) : null;
    paint();
  }

  async function addRow() {
    if (!canEdit || !selected) return;
    if (!String(form.dose || "").trim() || !String(form.prescribedBy || "").trim()) {
      toast("Enter the dose and who prescribed it.");
      return;
    }
    if (!form.allergyAck) {
      toast("Confirm the allergy note before adding the prescription.");
      return;
    }
    const item = FORMULARY.find((row) => row.label === form.drug) || FORMULARY[0];
    busy = true;
    paint();
    try {
      const row = {
        at: new Date().toISOString(),
        drug: item.label,
        dose: form.dose.trim(),
        route: item.route,
        frequency: form.frequency,
        prescribedBy: form.prescribedBy.trim(),
        status: "active",
      };
      const rows = [...(selected.medOrders || []), row];
      const text = rows.map((entry) => [entry.drug, entry.dose, entry.frequency].filter(Boolean).join(" ")).join("; ");
      const data = await api.updatePatient(selected.patientId, { medOrders: rows, medicines: text });
      selected = data.patient;
      form.allergyAck = false;
      toast("Added to the medication chart.");
    } catch (err) {
      toast(err.message || "Could not save.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const rows = selected?.medOrders || [];
    const item = FORMULARY.find((row) => row.label === form.drug) || FORMULARY[0];
    mount(target, cmsWindow("Medication Chart (eMAR — Electronic Medication Administration Record)",
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm" }, error) : null,
      activePatientBar(selected),
      el("div", { class: "mb-2" }, patientPicker(patients, selected?.patientId || "", choose)),
      el("p", { class: "mb-2 text-xs text-gray-700" }, "Allergies: Unknown / not assessed"),
      el("p", { class: "mb-3 text-[11px] leading-relaxed text-gray-600" },
        "Prescribe, then the chart keeps the order on this patient. Teaching stock is a label only, not a live pharmacy."
      ),
      el("div", { class: "flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row" },
        canEdit && el("div", { class: "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
          el("h3", { class: "mb-3 border-b border-gray-400 pb-1 font-bold text-ha-blue" }, "New Prescription"),
          el("label", { class: "text-xs font-bold" }, "Drug (Formulary)",
            el("select", {
              class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
              value: form.drug,
              onChange: (e) => { form.drug = e.target.value; paint(); },
            }, ...FORMULARY.map((row) => el("option", { value: row.label }, row.label)))
          ),
          el("p", { class: "mt-2 text-xs" },
            "Pharmacy stock: ",
            el("span", { class: "rounded bg-green-100 px-1 font-bold text-green-800" }, "In stock"),
            ` ${item.stock} unit(s) on hand`
          ),
          el("label", { class: "mt-2 block text-xs font-bold" }, "Dose",
            el("input", {
              class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
              value: form.dose,
              onInput: (e) => { form.dose = e.target.value; },
            })
          ),
          el("p", { class: "mt-1 text-[11px] text-gray-600" }, `Route: ${item.route.toLowerCase()} · ${item.perDose}.`),
          el("label", { class: "mt-2 block text-xs font-bold" }, "Frequency",
            el("select", {
              class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
              value: form.frequency,
              onChange: (e) => { form.frequency = e.target.value; },
            }, ...DOSE_FREQ.map((option) => el("option", { value: option }, option)))
          ),
          el("label", { class: "mt-2 block text-xs font-bold" }, "Prescribed by",
            el("input", {
              class: "mt-1 w-full border border-gray-500 bg-white px-2 py-1 text-xs",
              value: form.prescribedBy,
              onInput: (e) => { form.prescribedBy = e.target.value; },
            })
          ),
          el("label", { class: "mt-3 flex items-start gap-2 bg-[#ffffcc] p-2 text-[11px]" },
            el("input", {
              type: "checkbox",
              class: "mt-0.5",
              checked: form.allergyAck,
              onChange: (e) => { form.allergyAck = e.target.checked; },
            }),
            "Allergy history is unknown; I have reviewed this uncertainty for the demonstration."
          ),
          el("button", { class: `${BTN} mt-3 w-full`, disabled: busy, onClick: addRow }, busy ? "Saving…" : "+ Add to Chart")
        ),
        el("div", { class: "flex flex-1 flex-col overflow-auto border border-gray-400 bg-white" },
          el("div", { class: "bg-[#008080] px-2 py-1 text-xs font-bold text-white" }, `Prescriptions for Current Patient (${rows.length})`),
          rows.length
            ? el("table", { class: "w-full text-left text-xs" },
                el("thead", { class: "bg-slate-100" },
                  el("tr", {}, ["Drug", "Dose", "Route", "Frequency", "Prescribed by"].map((h) => el("th", { class: "p-2" }, h)))
                ),
                el("tbody", {}, ...rows.slice().reverse().map((row) => el("tr", { class: "border-t" },
                  el("td", { class: "p-2" }, row.drug || "—"),
                  el("td", { class: "p-2" }, row.dose || "—"),
                  el("td", { class: "p-2" }, row.route || "—"),
                  el("td", { class: "p-2" }, row.frequency || "—"),
                  el("td", { class: "p-2" }, row.prescribedBy || "—")
                )))
              )
            : el("div", { class: "p-8 text-center text-sm text-gray-500" }, "No prescriptions for this patient.")
        )
      )
    ));
  }

  try {
    patients = await loadPatients();
    form.prescribedBy = form.prescribedBy || state.user?.name || "";
    await choose(state.selectedPatientId || patients[0]?.patientId || "");
  } catch (err) {
    error = err.message;
    paint();
  }
}

export async function renderNotesPage({ target }) {
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
    } catch (err) {
      toast(err.message || "Could not save.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const rows = selected?.careNotes || [];
    mount(target, cmsWindow("Nursing / Care Notes (Multidisciplinary Progress Notes)",
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm" }, error) : null,
      activePatientBar(selected),
      el("div", { class: "mb-2 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs" },
        el("span", {}, "Select inpatient record:"),
        el("div", { class: "min-w-[16rem] flex-1" }, patientPicker(patients, selected?.patientId || "", choose))
      ),
      el("div", { class: "flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row" },
        canEdit && el("div", { class: "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
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
