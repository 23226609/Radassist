// src/components/newCase.js
// Upload X-ray → backend calls CURV AI → returns a draft case.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { nameFieldsFrom } from "../lib/patientName.js";

export async function renderNewCasePage({ target }) {
  // Local form state
  const f = {
    patientId: state.selectedPatientId || "",
    firstName: "",
    middleName: "",
    lastName: "",
    age: "",
    sex: "",
    history: "",
  };
  let preview = null;
  let busy = false;
  let progress = 0;
  let statusMsg = "";
  let found = null;

  function isXrayFile(file) {
    if (!file) return false;
    const type = String(file.type || "").toLowerCase();
    if (type.startsWith("image/")) return true;
    return /\.(png|jpe?g|webp)$/i.test(file.name || "");
  }

  function acceptFile(file) {
    if (!file) return;
    if (!isXrayFile(file)) {
      toast("Please drop a PNG, JPG, JPEG, or WebP image.");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(file);
    state.selectedFile = file;
    render();
  }

  function onPickFile(e) {
    acceptFile(e.target.files?.[0]);
  }

  function paintDropZone(node, active) {
    if (!node) return;
    node.classList.toggle("border-cyan-600", active);
    node.classList.toggle("bg-cyan-50", active);
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
        found = match;
        const names = nameFieldsFrom(match);
        f.firstName = names.firstName || f.firstName;
        f.middleName = names.middleName;
        f.lastName = names.lastName || f.lastName;
        f.age = match.age || f.age;
        f.sex = match.sex || f.sex;
        f.history = match.history || f.history;
        render();
        return;
      }
      const data = await api.listCases({ q: f.patientId });
      const exact = (data.cases || []).find(
        (c) => c.patientId.toLowerCase() === f.patientId.toLowerCase()
      );
      if (exact) {
        found = exact;
        const names = nameFieldsFrom(exact);
        f.firstName = names.firstName || f.firstName;
        f.middleName = names.middleName;
        f.lastName = names.lastName || f.lastName;
        f.age = exact.age || f.age;
        f.sex = exact.sex || f.sex;
        f.history = exact.history || f.history;
      } else {
        found = false;
      }
      render();
    } catch (err) {
      toast(err.message);
      render();
    }
  }

  async function analyze() {
    const file = state.selectedFile;
    if (!f.patientId || !f.firstName.trim() || !f.lastName.trim() || !f.age || !f.sex || !file) {
      toast("Complete patient details and choose an X-Ray image.");
      return;
    }
    busy = true;
    progress = 0;
    statusMsg = "Uploading to backend…";
    render();

    // Fake progress while waiting for the AI
    const tick = setInterval(() => {
      if (progress < 90) progress += 5;
      render();
    }, 700);

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

    try {
      const data = await api.createCase(fd);
      clearInterval(tick);
      progress = 100;
      statusMsg = data.aiError ? "Saved (AI unavailable)" : "Saved to MongoDB · AI report ready";
      render();
      toast("Case created.");
      // The backend returns the new case with imageUrl already resolved.
      const created = data.case;
      // Add it to the cached list and jump to review.
      state.cases = [created, ...state.cases.filter((x) => x.caseId !== created.caseId)];
      state.selectedCaseId = created.caseId;
      setTimeout(() => setPage("review"), 700);
    } catch (err) {
      clearInterval(tick);
      busy = false; progress = 0; statusMsg = "";
      render();
      toast(err.message || "Upload failed");
    }
  }

  function render() {
    const root = el(
      "main",
      { class: "mx-auto max-w-5xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("dashboard"),
      }, svgIcon("arrow-left", { size: 16 }), "Dashboard"),
      el("h1", { class: "text-3xl font-bold text-slate-900" }, "New X-Ray case"),
      el("p", { class: "mt-2 text-slate-500" },
        "Uploads go to the FastAPI middleware (port 8001) which forwards to the local CURV model. ",
        "Images are stored in MongoDB GridFS and reports are indexed by case ID."
      ),

      // Step 1 — patient
      el("section", { class: "card mt-6" },
        el("h2", { class: "text-lg font-bold text-slate-900" }, "1. Patient lookup"),
        el("div", { class: "mt-4 flex gap-3 flex-wrap" },
          el("input", {
            class: "flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
            value: f.patientId,
            placeholder: "Patient ID (e.g. PT-2026-0001)",
            onInput: (e) => (f.patientId = e.target.value),
          }),
          el("button", {
            class: "rounded-xl bg-slate-900 px-4 py-2.5 font-semibold text-white hover:bg-slate-800",
            onClick: lookup,
          }, "Lookup")
        ),
        found === false ? el("p", { class: "mt-3 text-sm text-slate-500" }, "New patient — fill in details below.") : null,
        found && typeof found === "object"
          ? el("p", { class: "mt-3 text-sm text-green-700" },
              `Found existing record for ${f.patientId} (filled in known details).`)
          : null,
        el("div", { class: "mt-4 grid gap-3 sm:grid-cols-3" },
          el("input", {
            disabled: !!(found && typeof found === "object"),
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100",
            placeholder: "First name",
            value: f.firstName,
            onInput: (e) => (f.firstName = e.target.value),
          }),
          el("input", {
            disabled: !!(found && typeof found === "object"),
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100",
            placeholder: "Middle name (optional)",
            value: f.middleName,
            onInput: (e) => (f.middleName = e.target.value),
          }),
          el("input", {
            disabled: !!(found && typeof found === "object"),
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100",
            placeholder: "Last name",
            value: f.lastName,
            onInput: (e) => (f.lastName = e.target.value),
          }),
        ),
        el("div", { class: "mt-3 grid gap-3 sm:grid-cols-2" },
          el("input", {
            type: "number",
            disabled: !!(found && typeof found === "object"),
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100",
            placeholder: "Age",
            value: f.age,
            onInput: (e) => (f.age = e.target.value),
          }),
          el("select", {
            disabled: !!(found && typeof found === "object"),
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100",
            value: f.sex,
            onChange: (e) => (f.sex = e.target.value),
          },
            el("option", { value: "" }, "Sex"),
            el("option", { value: "Female" }, "Female"),
            el("option", { value: "Male" }, "Male"),
            el("option", { value: "Other" }, "Other")
          ),
          el("input", {
            disabled: !!(found && typeof found === "object"),
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100 sm:col-span-2",
            placeholder: "Clinical history",
            value: f.history,
            onInput: (e) => (f.history = e.target.value),
          })
        )
      ),

      // Step 2 — upload
      el("section", { class: "card mt-4" },
        el("h2", { class: "text-lg font-bold text-slate-900" }, "2. Upload X-Ray"),
        el("label", {
          id: "xray-drop",
          class: "mt-4 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 p-8 hover:bg-slate-50",
          dataset: { drop: "xray" },
          onDragEnter: (e) => e.preventDefault(),
          onDragOver,
          onDragLeave,
          onDrop,
        },
          svgIcon("image", { size: 32, class: "text-cyan-600" }),
          el("b", { class: "mt-2" }, state.selectedFile ? state.selectedFile.name : "Drag an X-ray here, or choose PNG, JPG, JPEG, or WebP"),
          el("span", { class: "text-xs text-slate-500 mt-1" }, "Drop a file onto this box · stored in MongoDB GridFS · analysed by CURV AI"),
          el("input", { type: "file", accept: ".png,.jpg,.jpeg,.webp,image/*", class: "hidden", onChange: onPickFile })
        ),
        preview
          ? el("div", { class: "mt-3 flex items-center gap-3" },
              el("img", { src: preview, class: "h-28 rounded-lg grayscale" }),
              el("span", { class: "text-sm text-slate-500" }, "Preview only. Real image goes to MongoDB on submit.")
            )
          : null
      ),

      // Step 3 — analyse
      el("section", { class: "card mt-4" },
        el("h2", { class: "font-bold text-slate-900" }, "3. AI analysis (CURV → MongoDB)"),
        busy && el("div", { class: "my-3 h-2 rounded bg-slate-200 overflow-hidden" },
          el("div", { class: "h-2 bg-cyan-600 transition-all", style: { width: `${progress}%` } })
        ),
        statusMsg && el("p", { class: "mb-2 text-xs text-slate-500" }, statusMsg),
        el("button", {
          class: "mt-3 inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 font-semibold text-white hover:bg-cyan-700 disabled:opacity-60",
          disabled: busy,
          onClick: analyze,
        }, busy ? `Analysing ${progress}%` : "Analyse X-Ray")
      )
    );

    mount(target, root);
  }

  if (f.patientId) await lookup();
  else render();
}
