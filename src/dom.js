// src/dom.js
// Tiny helpers for building & wiring DOM with plain JS (no JSX).

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, "");
    else if (v === false || v == null) {
      /* skip */
    } else if (k === "value" && tag === "textarea") {
      // Textareas ignore the value *attribute*. defaultValue + text content
      // is the HTML initial value; .value is the live one the user edits.
      node.defaultValue = String(v);
    } else if (k === "checked" || k === "disabled" || k === "selected" || k === "readOnly") {
      node[k] = v;
    } else if (k === "value" && (tag === "input" || tag === "select" || tag === "option" || tag === "button")) {
      // For form controls we set the .value property so it works for selects
      // (the value attribute on <option> sets initial state, but only the
      // property reflects user selection).
      node.value = String(v);
      if (tag === "option") node.setAttribute("value", String(v));
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  // Some test DOMs don't copy textarea child text into .value until this.
  if (tag === "textarea" && node.textContent && !node.value) {
    node.defaultValue = node.textContent;
    node.value = node.textContent;
  }
  // Options must exist before a <select> will honour .value. Setting it
  // earlier makes the first option look selected, so "All statuses" cannot
  // fire a change after you have filtered.
  if (tag === "select" && props?.value != null && props.value !== false) {
    node.value = String(props.value);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Re-render helper: completely replace the body of `target`.
// If a text field inside `target` had focus, put the caret back so a
// re-render doesn't feel like the box "won't let you type".
export function mount(target, ...children) {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const restore = active && target.contains?.(active) && "value" in active
    ? {
        id: active.id,
        start: active.selectionStart,
        end: active.selectionEnd,
      }
    : null;

  clear(target);
  for (const c of children) {
    if (c instanceof Node) target.appendChild(c);
  }

  if (!restore?.id) return;
  const next = document.getElementById(restore.id);
  if (!next || !target.contains(next) || typeof next.focus !== "function") return;
  next.focus();
  try {
    if (typeof next.setSelectionRange === "function" && restore.start != null) {
      next.setSelectionRange(restore.start, restore.end);
    }
  } catch {
    /* some input types don't support a caret */
  }
}
