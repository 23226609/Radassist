// src/main.js
// Entry point. Wires up the state-render cycle and renders the right page.

import { state, setState, setPage, subscribe, applyHash, parseHash } from "./state.js";
import { api, getSession } from "./api.js";
import { Shell } from "./components/header.js";
import { renderLoginPage, renderRegisterPage } from "./components/login.js";
import { renderDashboardPage, stopDashboardWatch } from "./components/dashboard.js";
import { renderNewCasePage } from "./components/newCase.js";
import { renderReviewPage, stopReviewWatch } from "./components/review.js";
import { renderAuditPage } from "./components/audit.js";
import { renderPatientsPage, renderPatientPage } from "./components/patients.js";
import { renderNewPatientPage } from "./components/newPatient.js";
import { renderCasesPage, renderCasePage, renderRequestedPage } from "./components/cases.js";
import { renderUsersPage } from "./components/users.js";
import { renderBedsPage, renderMonitorPage, renderLabsPage, renderMedsPage, renderNotesPage } from "./components/clinical.js";
import { renderSharePage } from "./components/shareView.js";
import { isReportPopup, renderReportViewPage } from "./components/reportView.js";
import { el, mount } from "./dom.js";
import { stopAnalysisWatch } from "./lib/analysisJob.js";
import { canUpload, canEditPatient, canSeeAudit, isAdmin, isTechnician } from "./lib/roles.js";
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
    shareToken: route.shareToken ?? null,
  };
}

async function bootstrap() {
  const route = parseHash();
  const session = getSession();
  if (route.page === "share") {
    setState({
      token: session?.token || null,
      user: session?.user || null,
      page: "share",
      shareToken: route.shareToken || null,
    }, { replaceHash: true });
    if (session?.token) {
      try {
        const me = await api.me();
        setState({ user: me.user }, { skipHash: true });
      } catch { /* public share still works */ }
    }
    return;
  }
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
  if (state.page === "share") {
    const target = el("div");
    mount(app,
      el("div", { class: "min-h-screen bg-slate-50 text-slate-900" }, target)
    );
    renderSharePage({ target });
    return;
  }

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

  if (!canSeeAudit(state.user) && state.page === "audit") {
    setPage("dashboard");
    return;
  }
  if (!isAdmin(state.user) && state.page === "users") {
    setPage("dashboard");
    return;
  }
  if (isTechnician(state.user) && ["dashboard", "cases", "case", "review", "labs", "meds"].includes(state.page)) {
    setPage("requests");
    return;
  }
  if (!canUpload(state.user) && state.page === "new") {
    setPage(isTechnician(state.user) ? "requests" : "dashboard");
    return;
  }
  if (!canEditPatient(state.user) && state.page === "new-patient") {
    setPage("patients");
    return;
  }
  if (state.page === "beds") {
    setPage("patients");
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
    case "users":     pageNode = "users";     break;
    case "beds":      pageNode = "beds";      break;
    case "monitor":   pageNode = "monitor";   break;
    case "labs":      pageNode = "labs";      break;
    case "meds":      pageNode = "meds";      break;
    case "notes":     pageNode = "notes";     break;
    case "requests":  pageNode = "requests";  break;
    default:          pageNode = "dashboard";
  }

  const shell = Shell({ onLogout: logout });
  mount(app, shell.root);
  const target = shell.main;

  if (pageNode !== "dashboard") stopDashboardWatch();
  if (pageNode !== "review") stopReviewWatch();

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
  } else if (pageNode === "users") {
    renderUsersPage({ target });
  } else if (pageNode === "beds") {
    renderBedsPage({ target });
  } else if (pageNode === "monitor") {
    renderMonitorPage({ target });
  } else if (pageNode === "labs") {
    renderLabsPage({ target });
  } else if (pageNode === "meds") {
    renderMedsPage({ target });
  } else if (pageNode === "notes") {
    renderNotesPage({ target });
  } else if (pageNode === "requests") {
    renderRequestedPage({ target });
  }
}

// Subscribe once — every setState() (including setPage) triggers a render.
subscribe(render);

try {
  window.addEventListener("hashchange", () => {
    if (isReportPopup()) return;
    const next = parseHash();
    if (!state.user) {
      if (next.page === "register" || next.page === "login" || next.page === "share") applyHash();
      return;
    }
    if (next.page === "login" || next.page === "register") return;
    applyHash();
  });
} catch { /* tests */ }

bootstrap();
render();
