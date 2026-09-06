// src/state.js
// Minimal pub-sub state store. The whole app subscribes once and re-renders
// on every state change.

const listeners = new Set();

export const state = {
  user: null,         // session user
  token: null,
  page: "login",      // current page: login | register | dashboard | new | review | cases | audit
  cases: [],          // all cases cached in memory
  selectedCaseId: null,
  pendingFilter: { status: "all", q: "" },
  loading: false,
  errorMsg: "",
  toast: "",          // transient banner text
};

export function setState(patch) {
  Object.assign(state, patch);
  // 1. Notify pub/sub subscribers
  for (const fn of listeners) fn();
  // 2. Also fire a DOM event so any non-subscriber listener can react
  window.dispatchEvent(new CustomEvent("state-render"));
}

export function setPage(page, payload = {}) {
  setState({ page, ...payload });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function toast(msg, ms = 3500) {
  setState({ toast: msg });
  setTimeout(() => {
    if (state.toast === msg) setState({ toast: "" });
  }, ms);
}
