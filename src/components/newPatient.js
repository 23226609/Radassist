// src/components/newPatient.js
// Register a patient before any X-ray is uploaded.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { composePatientName, nameFieldsFrom } from "../lib/patientName.js";
import { patientDisplayName } from "../lib/tags.js";
import {
  labeledField,
  sexPills,
  nameFieldGroup,
  paintNamePreview,
  paintMatchList,
  createPatientSearch,
  searchQueryFrom,
} from "./patientFields.js";

const CONTROL = "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100";

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
  const search = createPatientSearch({
    onHits: (hits) => paintMatchList(hits, { onPick: openExisting }),
  });

  function openExisting(p) {
    toast(`${patientDisplayName(p) || p.patientId} already has a chart.`);
    state.selectedPatientId = p.patientId;
    setPage("patient");
  }

  function refreshPreview() {
    paintNamePreview(f);
    search.schedule(searchQueryFrom(f));
  }

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
      { class: "page-enter mx-auto max-w-5xl px-5 py-8" },
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
        : el("div", { class: "mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]" },
            el("section", { class: "card" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Patient details"),
              el("div", { class: "mt-4" },
                nameFieldGroup({ f, onChange: refreshPreview })
              ),
              el("div", { class: "mt-4" },
                labeledField({ label: "Patient ID", optional: true, forId: "patient-id" },
                  el("input", {
                    id: "patient-id",
                    class: CONTROL,
                    placeholder: "Patient ID (optional — assigned automatically)",
                    value: f.patientId,
                    onInput: (e) => {
                      f.patientId = e.target.value;
                      refreshPreview();
                    },
                  })
                )
              ),
              el("div", { class: "mt-4 grid gap-4 sm:grid-cols-2" },
                labeledField({ label: "Age", required: true, forId: "patient-age" },
                  el("input", {
                    id: "patient-age",
                    type: "number",
                    min: "0",
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
                  sexPills({ f, onChange: () => paintNamePreview(f) })
                )
              ),
              el("div", { class: "mt-4" },
                labeledField({ label: "Clinical history", optional: true, forId: "patient-history" },
                  el("textarea", {
                    id: "patient-history",
                    class: CONTROL,
                    rows: 4,
                    placeholder: "Clinical history (optional)",
                    onInput: (e) => (f.history = e.target.value),
                  }, f.history)
                )
              ),
              el("div", { id: "patient-matches", class: "mt-4" }),
              el("button", {
                class: "mt-5 inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 font-semibold text-white hover:bg-cyan-700 disabled:opacity-60",
                disabled: busy,
                onClick: save,
              }, svgIcon("user-plus", { size: 16 }), busy ? "Saving…" : "Add patient")
            ),
            el("aside", { class: "card h-fit" },
              el("div", { class: "flex items-center gap-3" },
                el("span", {
                  id: "summary-initials",
                  class: "inline-flex h-11 w-11 items-center justify-center rounded-full bg-cyan-600 text-sm font-bold text-white",
                }, "?"),
                el("div", { class: "min-w-0" },
                  el("div", { id: "summary-full-name", class: "truncate font-semibold text-slate-900" }, "Name pending"),
                  el("div", { id: "summary-meta", class: "text-sm text-slate-500" }, "Age and sex pending")
                )
              ),
              el("p", { id: "summary-ready", class: "mt-3 text-sm text-slate-500" },
                "First name, last name, age and sex are required"
              )
            )
          )
    );
    mount(target, root);
    paintNamePreview(f);
  }

  render();
}
