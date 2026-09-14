// Popup report window: ?view=report&caseId=...

export function reportPopupUrl(caseId) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "report");
  url.searchParams.set("caseId", String(caseId || ""));
  return url.toString();
}

export function isReportPopup() {
  try {
    return new URLSearchParams(window.location.search).get("view") === "report";
  } catch {
    return false;
  }
}

export function reportPopupCaseId() {
  try {
    return new URLSearchParams(window.location.search).get("caseId") || "";
  } catch {
    return "";
  }
}
