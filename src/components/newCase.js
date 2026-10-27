// src/components/newCase.js
// Upload X-ray, return to the worklist, generate the draft in the background.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { nameFieldsFrom } from "../lib/patientName.js";
import { isTechnician } from "../lib/roles.js";
import { urgentBadge } from "../lib/tags.js";
import { startAnalysisWatch } from "../lib/analysisJob.js";
import {
  labeledField,
  sexPills,
  nameFieldGroup,
  paintNamePreview,
  paintMatchList,
  createPatientSearch,
  searchQueryFrom,
} from "./patientFields.js";

const CONTROL = "w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-ha-blue focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100";

export async function renderNewCasePage({ target }) {
  const f = {
    patientId: state.selectedPatientId || "",
    firstName: "",
    middleName: "",
    lastName: "",
    age: "",
    sex: "",
    history: "",
    requestCaseId: state.pendingRequestId || "",
  };
  let requests = [];
  let preview = null;
  let busy = false;
  let progress = 0;
  let statusMsg = "";
  let uploadError = "";
  let found = null;
  const search = createPatientSearch({
    onHits: (hits) => paintMatchList(hits, { onPick: applyPerson }),
  });

  function locked() {
    return !!(found && typeof found === "object");
  }

  function applyPerson(match) {
    if (!match) return;
    found = match;
    const names = nameFieldsFrom(match);
    f.patientId = match.patientId || f.patientId;
    f.firstName = names.firstName || f.firstName;
    f.middleName = names.middleName;
    f.lastName = names.lastName || f.lastName;
    f.age = match.age || f.age;
    f.sex = match.sex || f.sex;
    f.history = match.history || f.history;
    render();
  }

  function isDicomFile(file) {
    if (!file) return false;
    return /\.dcm$/i.test(file.name || "") || /dicom/i.test(file.type || "");
  }

  function isXrayFile(file) {
    if (!file) return false;
    if (isDicomFile(file)) return true;
    const type = String(file.type || "").toLowerCase();
    if (type.startsWith("image/")) return true;
    return /\.(png|jpe?g|webp)$/i.test(file.name || "");
  }

  function acceptFile(file) {
    if (!file) return;
    if (!isXrayFile(file)) {
      toast("Please drop a DICOM, PNG, JPG, JPEG, or WebP film.");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    preview = isDicomFile(file) ? "" : URL.createObjectURL(file);
    state.selectedFile = file;
    render();
  }

  function clearFile() {
    if (busy) return;
    if (preview) URL.revokeObjectURL(preview);
    preview = null;
    state.selectedFile = null;
    render();
  }

  function onPickFile(e) {
    acceptFile(e.target.files?.[0]);
    e.target.value = "";
  }

  function paintDropZone(node, active) {
    if (!node) return;
    node.classList.toggle("border-ha-blue", active);
    node.classList.toggle("bg-blue-50", active);
    node.classList.toggle("border-slate-300", !active);
  }

  function onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    paintDropZone(e.currentTarget, true);
  }

  function onDragLeave(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    paintDropZone(e.currentTarget, false);
  }

  function onDrop(e) {
    e.preventDefault();
    paintDropZone(e.currentTarget, false);
    acceptFile(e.dataTransfer?.files?.[0]);
  }

  async function lookup() {
    found = null;
    if (!f.patientId.trim()) return render();
    try {
      const people = await api.listPatients({ q: f.patientId });
      const match = (people.patients || []).find(
        (p) => String(p.patientId).toLowerCase() === f.patientId.toLowerCase()
      );
      if (match) {
        applyPerson(match);
        return;
      }
      const data = await api.listCases({ q: f.patientId });
      const exact = (data.cases || []).find(
        (c) => c.patientId.toLowerCase() === f.patientId.toLowerCase()
      );
      if (exact) applyPerson(exact);
      else {
        found = false;
        render();
      }
    } catch (err) {
      toast(err.message);
      render();
    }
  }

  async function analyze() {
    const file = state.selectedFile;
    if (!f.patientId || !f.firstName.trim() || !f.lastName.trim() || !f.age || !f.sex || !file) {
      uploadError = "Complete the patient details and choose an X-ray image before saving.";
      render();
      return;
    }
    busy = true;
    progress = 20;
    statusMsg = "Uploading the film…";
    render();

    const fd = new FormData();
    const names = nameFieldsFrom(f);
    fd.append("file", file);
    fd.append("patientId", f.patientId);
    fd.append("firstName", names.firstName);
    fd.append("middleName", names.middleName);
    fd.append("lastName", names.lastName);
    fd.append("patientName", names.name);
    fd.append("age", String(f.age));
    fd.append("sex", f.sex);
    fd.append("history", f.history || "");
    if (f.requestCaseId) fd.append("requestCaseId", f.requestCaseId);

    try {
      const data = await api.createCase(fd);
      const created = data.case;
      if (!created?.caseId) throw new Error("Case was saved without an id.");
      state.cases = [created, ...state.cases.filter((x) => x.caseId !== created.caseId)];
      state.selectedFile = null;
      state.pendingRequestId = null;
      toast("Film registered. The report is generating and will show as pending approve.");
      if (data.analysing !== false && !isTechnician(state.user)) {
        startAnalysisWatch({
          caseId: created.caseId,
          patientName: created.patientName,
          patientId: created.patientId,
          openReview: false,
        });
      }
      setPage(isTechnician(state.user) ? "requests" : "dashboard");
    } catch (err) {
      busy = false; progress = 0; statusMsg = "";
      uploadError = err.message || "The film was not saved. Check the image and try again.";
      render();
    }
  }

  function render() {
    const lock = locked();
    const backTo = isTechnician(state.user) ? "requests" : "dashboard";
    const root = el(
      "main",
      { class: "flex h-full min-h-0 flex-col overflow-hidden bg-[#d4d0c8] p-2" },
      el("div", { class: "flex h-full min-h-0 flex-col overflow-hidden border border-gray-500 bg-[#ece9d8] shadow-sm" },
        el("div", { class: "flex shrink-0 items-center justify-between gap-2 border-b border-gray-400 bg-[#d4d0c8] px-2 py-1" },
          el("div", { class: "min-w-0" },
            el("h1", { class: "text-sm font-bold text-slate-900" }, "Registration"),
            el("p", { class: "truncate text-[11px] text-slate-600" },
              "Register the patient and save the film. The draft report starts once the film is stored."
            )
          ),
          el("button", {
            type: "button",
            class: "inline-flex shrink-0 items-center gap-1 border border-gray-500 bg-[#ece9d8] px-2 py-0.5 text-[11px] font-semibold hover:bg-white",
            onClick: () => setPage(backTo),
          }, svgIcon("arrow-left", { size: 14 }), isTechnician(state.user) ? "Requested case" : "Work list")
        ),
        requests.length ? el("label", { class: "flex shrink-0 items-center gap-2 border-b border-gray-300 bg-[#f4f7fb] px-2 py-1 text-xs font-semibold text-slate-800" },
          "Open request",
          requests.find((row) => (row.caseId || row._id) === f.requestCaseId)?.urgent ? urgentBadge() : null,
          el("select", {
            class: `min-w-0 flex-1 ${CONTROL}`,
            value: f.requestCaseId,
            onChange: (e) => {
              f.requestCaseId = e.target.value;
              const hit = requests.find((row) => (row.caseId || row._id) === f.requestCaseId);
              if (hit) applyPerson(hit);
              else render();
            },
          },
            el("option", { value: "" }, "No request — register a new film"),
            ...requests.map((row) => el("option", { value: row.caseId || row._id },
              `${row.urgent ? "Urgent · " : ""}${row.patientId} · ${row.patientName || row.caseId} · requested`
            ))
          )
        ) : null,
        el("div", { class: "grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 md:grid-cols-2" },
          el("section", { class: "flex min-h-0 flex-col overflow-hidden border border-gray-400 bg-white p-2" },
            el("h2", { class: "text-sm font-bold text-slate-900" }, "1. Patient"),
            el("div", { class: "mt-2 flex gap-2" },
              el("input", {
                class: `min-w-0 flex-1 ${CONTROL}`,
                value: f.patientId,
                placeholder: "Patient ID (e.g. PT-2026-0001)",
                onInput: (e) => {
                  f.patientId = e.target.value;
                  found = null;
                  search.schedule(searchQueryFrom(f));
                },
              }),
              el("button", {
                type: "button",
                class: "shrink-0 rounded border border-gray-500 bg-slate-900 px-3 py-1 text-sm font-semibold text-white hover:bg-slate-800",
                onClick: lookup,
              }, "Lookup")
            ),
            found === false ? el("p", { class: "mt-1 text-xs text-slate-500" }, "New patient — fill in details below.") : null,
            lock
              ? el("p", { class: "mt-1 text-xs text-green-700" },
                  `Found existing record for ${f.patientId} (filled in known details).`)
              : null,
            el("div", { id: "patient-matches", class: "mt-2 max-h-24 overflow-y-auto" }),
            el("div", { class: "mt-2 min-h-0 flex-1 overflow-y-auto" },
              nameFieldGroup({
                f,
                middleBelow: true,
                disabled: lock,
                onChange: () => {
                  paintNamePreview(f);
                  if (!lock) search.schedule(searchQueryFrom(f));
                },
              }),
              el("div", { class: "mt-2 grid gap-2 sm:grid-cols-2" },
                labeledField({ label: "Age", required: true, forId: "case-age" },
                  el("input", {
                    id: "case-age",
                    type: "number",
                    min: "0",
                    disabled: lock,
                    class: CONTROL,
                    placeholder: "Age",
                    value: f.age,
                    onInput: (e) => {
                      f.age = e.target.value;
                      paintNamePreview(f);
                    },
                  })
                ),
                labeledField({ label: "Sex", required: true },
                  sexPills({ f, disabled: lock, onChange: () => paintNamePreview(f) })
                ),
                el("div", { class: "sm:col-span-2" },
                  labeledField({ label: "Clinical history", optional: true, forId: "case-history" },
                    el("input", {
                      id: "case-history",
                      disabled: lock,
                      class: CONTROL,
                      placeholder: "Clinical history",
                      value: f.history,
                      onInput: (e) => (f.history = e.target.value),
                    })
                  )
                )
              )
            )
          ),
          el("section", { class: "flex min-h-0 flex-col overflow-hidden border border-gray-400 bg-white p-2" },
            el("h2", { class: "text-sm font-bold text-slate-900" }, "2. Upload X-Ray"),
            el("label", {
              id: "xray-drop",
              class: "mt-2 flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-slate-300 px-3 py-3 text-center hover:bg-slate-50",
              dataset: { drop: "xray" },
              onDragEnter: (e) => e.preventDefault(),
              onDragOver,
              onDragLeave,
              onDrop,
            },
              svgIcon("image", { size: 28, class: "text-ha-blue" }),
              el("b", { class: "mt-1 text-sm" }, state.selectedFile ? state.selectedFile.name : "Drag an X-ray here, or choose DICOM, PNG, JPG, JPEG, or WebP"),
              el("span", { class: "mt-1 text-xs text-slate-500" },
                state.selectedFile
                  ? "Drop another file to replace it, or remove it below."
                  : "DICOM, PNG, JPG, JPEG, or WebP. A DICOM film is rendered before CURV sees it."
              ),
              el("input", { type: "file", accept: ".dcm,.png,.jpg,.jpeg,.webp,image/*,application/dicom", class: "hidden", onChange: onPickFile })
            ),
            state.selectedFile
              ? el("div", { class: "mt-2 flex shrink-0 items-center gap-2" },
                  preview && !isTechnician(state.user) ? el("img", { src: preview, class: "h-14 rounded grayscale" }) : null,
                  el("div", { class: "min-w-0 flex-1" },
                    el("p", { class: "truncate text-sm font-medium text-slate-800" }, state.selectedFile?.name || "Selected film"),
                    el("p", { class: "truncate text-xs text-slate-500" },
                      preview
                        ? "Preview only. The original file is stored when you upload."
                        : "DICOM selected. The pixels are rendered to a viewable film when you save, and that film is what CURV reads."
                    )
                  ),
                  el("button", {
                    type: "button",
                    class: "inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
                    disabled: busy,
                    onClick: (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      clearFile();
                    },
                  }, svgIcon("x", { size: 14 }), "Remove")
                )
              : null
          )
        ),
        el("div", { class: "flex shrink-0 items-center justify-between gap-3 border-t border-gray-400 bg-[#f7f7f7] px-2 py-1.5" },
          el("div", { class: "min-w-0" },
            el("p", { class: "truncate text-[11px] text-slate-600" },
              "The film is stored, then the draft report is generated. The radiologist finds it as pending approve."
            ),
            busy && el("div", { class: "mt-1 h-1.5 overflow-hidden rounded bg-slate-200" },
              el("div", { class: "h-1.5 bg-ha-blue transition-all", style: { width: `${progress}%` } })
            ),
            statusMsg && el("p", { class: "text-[11px] text-slate-500" }, statusMsg)
          ),
          el("button", {
            type: "button",
            class: "inline-flex shrink-0 items-center gap-2 rounded bg-ha-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#074f85] disabled:opacity-60",
            disabled: busy,
            onClick: analyze,
          }, busy ? "Saving…" : "Save with film")
        )
      ),
      uploadError && el("div", {
        class: "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "upload-error-title",
      },
        el("div", { class: "w-full max-w-md rounded-xl bg-white p-5 shadow-xl" },
          el("h2", { id: "upload-error-title", class: "text-lg font-bold text-slate-900" }, "The film was not saved"),
          el("p", { class: "mt-2 text-sm leading-6 text-slate-700" }, uploadError),
          f.requestCaseId
            ? el("p", { class: "mt-2 text-sm leading-6 text-slate-700" }, "This request is still in Requested case. You can choose the film and save it again.")
            : null,
          el("button", {
            type: "button",
            class: "mt-4 rounded-xl bg-ha-blue px-4 py-2 text-sm font-semibold text-white",
            onClick: () => { uploadError = ""; render(); },
          }, "Close")
        )
      )
    );

    mount(target, root);
    paintNamePreview(f);
  }

  try {
    const data = await api.listCases({ status: "requested" });
    requests = data.cases || [];
  } catch { requests = []; }
  const preset = requests.find((row) => (row.caseId || row._id) === f.requestCaseId);
  if (preset) applyPerson(preset);
  else if (f.patientId) await lookup();
  else render();
}
