// src/components/newPatient.js
// Register a patient before any X-ray is uploaded.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { composePatientName, nameFieldsFrom } from "../lib/patientName.js";

export async function renderNewPatientPage({ target }) {
  const canAdd = state.user?.role !== "nurse";
  const f = {
    patientId: "",
    firstName: "",
    middleName: "",
    lastName: "",
    age: "",
    sex: "",
    history: "",
  };
  let busy = false;

  async function save() {
    if (!canAdd || busy) return;
    if (!f.firstName.trim() || !f.lastName.trim()) {
      toast("Enter first name and last name.");
      return;
    }
    if (!f.age || !f.sex) {
      toast("Enter age and sex.");
      return;
    }
    busy = true;
    render();
    try {
      const names = nameFieldsFrom(f);
      const data = await api.createPatient({
        patientId: f.patientId.trim(),
        firstName: names.firstName,
        middleName: names.middleName,
        lastName: names.lastName,
        age: String(f.age).trim(),
        sex: f.sex,
        history: f.history.trim(),
      });
      const created = data.patient || {};
      toast(`Added ${composePatientName(created) || names.name}.`);
      state.selectedPatientId = created.patientId;
      setPage("patient");
    } catch (err) {
      busy = false;
      render();
      toast(err.message || "Could not add this patient.");
    }
  }

  function render() {
    const root = el(
      "main",
      { class: "mx-auto max-w-3xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("patients"),
      }, svgIcon("arrow-left", { size: 16 }), "Patients"),
      el("h1", { class: "text-3xl font-bold text-slate-900" }, "New patient"),
      el("p", { class: "mt-2 text-slate-500" },
        "Add a chart so this person is ready before an X-ray is uploaded."
      ),

      !canAdd
        ? el("p", { class: "card mt-6 text-slate-600" }, "Nurses cannot add patients.")
        : el("section", { class: "card mt-6" },
            el("h2", { class: "text-lg font-bold text-slate-900" }, "Patient details"),
            el("div", { class: "mt-4 grid gap-3 sm:grid-cols-3" },
              el("input", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
                placeholder: "First name",
                value: f.firstName,
                onInput: (e) => (f.firstName = e.target.value),
              }),
              el("input", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
                placeholder: "Middle name (optional)",
                value: f.middleName,
                onInput: (e) => (f.middleName = e.target.value),
              }),
              el("input", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
                placeholder: "Last name",
                value: f.lastName,
                onInput: (e) => (f.lastName = e.target.value),
              }),
            ),
            el("div", { class: "mt-3 grid gap-3 sm:grid-cols-2" },
              el("input", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 sm:col-span-2",
                placeholder: "Patient ID (optional — assigned automatically)",
                value: f.patientId,
                onInput: (e) => (f.patientId = e.target.value),
              }),
              el("input", {
                type: "number",
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
                placeholder: "Age",
                value: f.age,
                onInput: (e) => (f.age = e.target.value),
              }),
              el("select", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
                value: f.sex,
                onChange: (e) => (f.sex = e.target.value),
              },
                el("option", { value: "" }, "Sex"),
                el("option", { value: "Female" }, "Female"),
                el("option", { value: "Male" }, "Male"),
                el("option", { value: "Other" }, "Other")
              ),
              el("textarea", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 sm:col-span-2",
                rows: 4,
                placeholder: "Clinical history (optional)",
                onInput: (e) => (f.history = e.target.value),
              }, f.history)
            ),
            el("button", {
              class: "mt-5 inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 font-semibold text-white hover:bg-cyan-700 disabled:opacity-60",
              disabled: busy,
              onClick: save,
            }, svgIcon("user-plus", { size: 16 }), busy ? "Saving…" : "Add patient")
          )
    );
    mount(target, root);
  }

  render();
}
