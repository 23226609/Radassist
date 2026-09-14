// src/main.js
// Entry point. Wires up the state-render cycle and renders the right page.

import { state, setState, subscribe, applyHash, parseHash } from "./state.js";
import { api, getSession } from "./api.js";
import { Shell } from "./components/header.js";
import { renderLoginPage, renderRegisterPage } from "./components/login.js";
import { renderDashboardPage } from "./components/dashboard.js";
import { renderNewCasePage } from "./components/newCase.js";
import { renderReviewPage } from "./components/review.js";
import { renderAuditPage } from "./components/audit.js";
import { renderPatientsPage, renderPatientPage } from "./components/patients.js";
import { renderNewPatientPage } from "./components/newPatient.js";
import { renderCasesPage, renderCasePage } from "./components/cases.js";
import { isReportPopup, renderReportViewPage } from "./components/reportView.js";
import { el, mount } from "./dom.js";
import { stopAnalysisWatch } from "./lib/analysisJob.js";
import "./index.css";

const app = document.getElementById("app");

async function logout() {
  stopAnalysisWatch();
  try { await api.logout(); } catch { /* ignore */ }
  setState({ user: null, token: null, page: "login", cases: [], selectedCaseId: null, selectedPatientId: null });
}

function routeFromHash() {
  const route = parseHash();
  if (!route.page || route.page === "login" || route.page === "register") {
    return { page: "dashboard", selectedCaseId: null, selectedPatientId: null };
  }
  return {
    page: route.page,
    selectedCaseId: route.selectedCaseId ?? null,
    selectedPatientId: route.selectedPatientId ?? null,
  };
}

async function bootstrap() {
  const session = getSession();
  if (session?.token) {
    const route = routeFromHash();
    setState({
      token: session.token,
      user: session.user,
      ...route,
    }, { replaceHash: true });
    try {
      const me = await api.me();
      setState({ user: me.user }, { skipHash: true });
    } catch {
      setState({ token: null, user: null, page: "login" });
    }
  } else {
    const route = parseHash();
    setState({
      page: route.page === "register" ? "register" : "login",
    }, { replaceHash: true });
  }
}

function render() {
  // Login / Register are full-page views.
  if (!state.user) {
    if (state.page === "register") renderRegisterPage();
    else renderLoginPage();
    return;
  }

  // ?view=report&caseId=... is opened as its own browser window.
  // Don't remount if it's already up — a second pass (session refresh)
  // would destroy the textareas the doctor is typing in.
  if (isReportPopup()) {
    if (app.dataset.reportPopup === "1") return;
    app.dataset.reportPopup = "1";
    const target = el("div");
    mount(app,
      el("div", { class: "min-h-screen bg-slate-50 text-slate-900" }, target)
    );
    renderReportViewPage({ target });
    return;
  }

  let pageNode;

  switch (state.page) {
    case "dashboard": pageNode = "dashboard"; break;
    case "new":       pageNode = "new";       break;
    case "review":    pageNode = "review";    break;
    case "audit":     pageNode = "audit";     break;
    case "patients":    pageNode = "patients";     break;
    case "patient":     pageNode = "patient";      break;
    case "new-patient": pageNode = "new-patient";  break;
    case "cases":     pageNode = "cases";     break;
    case "case":      pageNode = "case";      break;
    default:          pageNode = "dashboard";
  }

  const shell = Shell({ onLogout: logout });
  mount(app, shell.root);
  const target = shell.main;

  // Now mount the page content into target.
  if (pageNode === "dashboard") {
    renderDashboardPage({ target });
  } else if (pageNode === "new") {
    renderNewCasePage({ target });
  } else if (pageNode === "review") {
    renderReviewPage({ target });
  } else if (pageNode === "audit") {
    renderAuditPage({ target });
  } else if (pageNode === "patients") {
    renderPatientsPage({ target });
  } else if (pageNode === "patient") {
    renderPatientPage({ target });
  } else if (pageNode === "new-patient") {
    renderNewPatientPage({ target });
  } else if (pageNode === "cases") {
    renderCasesPage({ target });
  } else if (pageNode === "case") {
    renderCasePage({ target });
  }
}

// Subscribe once — every setState() (including setPage) triggers a render.
subscribe(render);

try {
  window.addEventListener("hashchange", () => {
    if (isReportPopup()) return;
    const next = parseHash();
    if (!state.user) {
      if (next.page === "register" || next.page === "login") applyHash();
      return;
    }
    if (next.page === "login" || next.page === "register") return;
    applyHash();
  });
} catch { /* tests */ }

bootstrap();
render();
