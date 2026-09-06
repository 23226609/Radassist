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
      // Textareas don't honour the value attribute — set as textContent instead.
      node.value = String(v);
    } else if (k === "checked" || k === "disabled" || k === "selected") {
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
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Re-render helper: completely replace the body of `target`.
export function mount(target, ...children) {
  clear(target);
  for (const c of children) {
    if (c instanceof Node) target.appendChild(c);
  }
}
