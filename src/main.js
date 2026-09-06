// src/main.js
// Entry point. Wires up the state-render cycle and renders the right page.

import { state, setState, subscribe, setPage } from "./state.js";
import { api, getSession } from "./api.js";
import { Header } from "./components/header.js";
import { renderLoginPage, renderRegisterPage } from "./components/login.js";
import { renderDashboardPage } from "./components/dashboard.js";
import { renderNewCasePage } from "./components/newCase.js";
import { renderReviewPage } from "./components/review.js";
import { renderAuditPage } from "./components/audit.js";
import { el, mount } from "./dom.js";
import "./index.css";

const app = document.getElementById("app");

async function logout() {
  try { await api.logout(); } catch { /* ignore */ }
  setState({ user: null, token: null, page: "login", cases: [], selectedCaseId: null });
}

async function bootstrap() {
  const session = getSession();
  if (session?.token) {
    setState({ token: session.token, user: session.user, page: "dashboard" });
    try {
      const me = await api.me();
      setState({ user: me.user });
    } catch {
      // token invalid; bounce to login
      setState({ token: null, user: null, page: "login" });
    }
  } else {
    setState({ page: "login" });
  }
}

function render() {
  // Login / Register are full-page views.
  if (!state.user) {
    if (state.page === "register") renderRegisterPage();
    else renderLoginPage();
    return;
  }

  const target = el("div");
  let pageNode;

  // Build header + selected page.
  const header = Header({ onLogout: logout });
  switch (state.page) {
    case "dashboard": pageNode = "dashboard"; break;
    case "new":       pageNode = "new";       break;
    case "review":    pageNode = "review";    break;
    case "audit":     pageNode = "audit";     break;
    default:          pageNode = "dashboard";
  }

  // Toast banner
  const toastEl = state.toast
    ? el("div", { class: "fixed top-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow z-50" },
        state.toast)
    : null;

  mount(app,
    el("div", { class: "min-h-screen bg-slate-50 text-slate-900" },
      header,
      toastEl,
      target
    )
  );

  // Now mount the page content into target.
  if (pageNode === "dashboard") {
    renderDashboardPage({ target });
  } else if (pageNode === "new") {
    renderNewCasePage({ target });
  } else if (pageNode === "review") {
    renderReviewPage({ target });
  } else if (pageNode === "audit") {
    renderAuditPage({ target });
  }
}

// Subscribe once — every setState() (including setPage) triggers a render.
subscribe(render);

bootstrap();
render();
