// Building blocks shared by the Settings, History and Setup pages: System Settings-style cards, rows, switches,
// radio rows, tiles and line icons (the SF Symbols the macOS app uses, redrawn as SVG). Pages re-render from a
// snapshot, like the SwiftUI views did.

import type {} from "../shared/bridge"; // window.vcli (the preload bridge)

export type Child = Node | string | null | undefined | false | Child[];

/** h("div.card.big", {onclick}, children…) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, any> | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Record<string, any> | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs?: Record<string, any> | null, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") for (const [prop, val] of Object.entries(v)) {
      if (prop.startsWith("--")) el.style.setProperty(prop, String(val)); else (el.style as any)[prop] = val;
    }
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

// ── Icons (24×24 line art) ──────────────────────────────────────────────────────────────────────────────────────

const PATHS: Record<string, string> = {
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9"/><circle cx="12" cy="12" r="6.6"/>',
  sparkles: '<path d="M11 3.5l1.8 4.9 4.9 1.8-4.9 1.8L11 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  waveform: '<path d="M3 10v4M7 6.5v11M11 3.5v17M15 7.5v9M19 9.5v5"/>',
  cursor: '<path d="M9 9l4.8 11.5 1.7-5 5-1.7z"/><path d="M6.8 2.8l.7 2.6M2.8 6.8l2.6.7M12.6 4.2l-1.9 1.9M4.2 12.6l1.9-1.9"/>',
  people: '<circle cx="8.5" cy="8" r="3.2"/><path d="M2.5 19.5a6 6 0 0 1 12 0"/><path d="M15.5 4.9a3.2 3.2 0 0 1 0 6.2M18 13.6a6 6 0 0 1 3.5 5.9"/>',
  wand: '<path d="M4 20L15 9"/><path d="M15 3.5v2M15 12.5v2M20.5 9h-2M11.5 9h-2M18.9 5.1l-1.4 1.4M18.9 12.9l-1.4-1.4M11.1 5.1l1.4 1.4"/>',
  puzzle: '<path d="M5 8h3.5a2.3 2.3 0 1 1 4.6 0H16.5v3.5a2.3 2.3 0 1 1 0 4.6V20H13a2.3 2.3 0 1 0-4.6 0H5v-4.2a2.3 2.3 0 1 0 0-4.6z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.4-3.4a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  hand: '<path d="M18 11V6.5a1.8 1.8 0 0 0-3.6 0V11M14.4 10V4.3a1.8 1.8 0 0 0-3.6 0V10M10.8 10.5V6a1.8 1.8 0 0 0-3.6 0v8.5"/><path d="M18 9a1.8 1.8 0 1 1 3.6 0v5a8 8 0 0 1-8 8h-1.6c-2.7 0-4.3-.8-5.8-2.3l-3.4-3.5a1.9 1.9 0 0 1 2.7-2.7l2.7 2.6"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M18.5 10.5v1a6.5 6.5 0 0 1-13 0v-1M12 18v3.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2" stroke-dasharray="3 2.2"/><circle cx="12" cy="10.5" r="2.6" fill="currentColor"/><path d="M8 21h8"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.2"/><path d="M6.5 9l3.5 3-3.5 3M12 15.5h5"/>',
  brain: '<path d="M12 5.5a3 3 0 0 0-5.6-1.4A3.5 3.5 0 0 0 4 9a3.5 3.5 0 0 0 .6 5.8A3.5 3.5 0 0 0 8 20a3 3 0 0 0 4-1z"/><path d="M12 5.5a3 3 0 0 1 5.6-1.4A3.5 3.5 0 0 1 20 9a3.5 3.5 0 0 1-.6 5.8A3.5 3.5 0 0 1 16 20a3 3 0 0 1-4-1z"/><path d="M12 5.5V19"/>',
  speaker: '<path d="M11 5L6.5 9H3v6h3.5l4.5 4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  seal: '<path d="M12 2.5l2.4 1.7 2.9.2 1 2.8 2.3 1.8-.9 2.9.9 2.8-2.3 1.8-1 2.8-2.9.2L12 21.5l-2.4-1.7-2.9-.2-1-2.8-2.3-1.8.9-2.8-.9-2.9 2.3-1.8 1-2.8 2.9-.2z" fill="currentColor"/><path d="M8.5 12l2.4 2.4 4.6-4.8" stroke="#fff"/>',
  check: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M7.5 12.2l3 3 6-6.2" stroke="#fff" stroke-width="2.2"/>',
  dotted: '<circle cx="12" cy="12" r="9" stroke-dasharray="2 2.6"/>',
  play: '<circle cx="12" cy="12" r="9.5"/><path d="M10 8.3l5.5 3.7-5.5 3.7z" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.2 16.2L21 21"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M4 6.5h16M9 6.5V4.5h6v2M6.5 6.5l1 13.5h9l1-13.5"/>',
};

export function icon(name: string, size = 16, cls = ""): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ""}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** A white symbol on a colored rounded square, as in the System Settings sidebar. */
export function tile(symbol: string, tint: string, size: number): HTMLElement {
  return h("span.tile", { style: { width: `${size}px`, height: `${size}px`, borderRadius: `${size * 0.24}px`, "--tint": tint } as any }, icon(symbol, Math.round(size * 0.62)));
}

// ── Rows and controls ───────────────────────────────────────────────────────────────────────────────────────────

/** A rounded group of rows with an optional title above and note below; dividers go between rows. */
export function card(title: string | null, footer: string | null, rows: Child[]): HTMLElement {
  const items = rows.flat(Infinity as 1).filter(Boolean) as Node[];
  const body = h("div.card-body");
  items.forEach((r, i) => { if (i > 0) body.appendChild(h("div.divider")); body.appendChild(r); });
  return h("section.card", null, title ? h("h3.card-title", null, title) : null, body, footer ? h("p.card-footer", null, footer) : null);
}

export function row(title: string, detail: string | null | undefined, control: Child, opts: { detailClass?: string } = {}): HTMLElement {
  return h("div.row", null,
    h("div.row-text", null, h("div.row-title", null, title), detail ? h("div.row-detail" + (opts.detailClass ? "." + opts.detailClass : ""), null, detail) : null),
    h("div.row-control", null, control));
}

export function toggle(on: boolean, set: (on: boolean) => void, disabled = false): HTMLElement {
  return h("label.switch" + (disabled ? ".disabled" : ""), null,
    h("input", { type: "checkbox", checked: on, disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }),
    h("span.knob"));
}

export function switchRow(title: string, detail: string | null, on: boolean, set: (on: boolean) => void, disabled = false): HTMLElement {
  const r = row(title, detail, toggle(on, set, disabled));
  if (disabled) r.classList.add("disabled");
  return r;
}

export function radioMark(selected: boolean): HTMLElement {
  return h("span.radio" + (selected ? ".on" : ""));
}

/** One choice of several, with a line explaining it. */
export function radioRow(title: string, detail: string | null, selected: boolean, action: () => void, enabled = true, extra?: Child): HTMLElement {
  return h("div.radio-row" + (enabled ? "" : ".disabled") + (selected ? ".selected" : ""), {
    role: "radio", "aria-checked": String(selected), tabindex: enabled ? 0 : -1,
    onclick: () => { if (enabled && !selected) action(); },
    onkeydown: (e: KeyboardEvent) => { if ((e.key === " " || e.key === "Enter") && enabled && !selected) { e.preventDefault(); action(); } },
  }, radioMark(selected), h("div.row-text", null, h("div.row-title", null, title), detail ? h("div.row-detail", null, detail) : null, extra ?? null));
}

export function button(label: string, action: () => void, opts: { disabled?: boolean; primary?: boolean; large?: boolean; title?: string } = {}): HTMLButtonElement {
  return h("button" + (opts.primary ? ".primary" : "") + (opts.large ? ".large" : ""), { onclick: action, disabled: !!opts.disabled, title: opts.title }, label) as HTMLButtonElement;
}

export interface Option { value: string; label: string; divider?: boolean }

/** A pop-up menu. Options flagged `divider` get a separator line before them. */
export function select(value: string, options: Option[], set: (v: string) => void): HTMLSelectElement {
  const s = h("select", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
  for (const o of options) {
    if (o.divider) s.appendChild(h("hr"));
    s.appendChild(h("option", { value: o.value, selected: o.value === value }, o.label));
  }
  s.value = value;
  return s;
}

export function segmented(value: string, options: Option[], set: (v: string) => void): HTMLElement {
  return h("div.segmented", { role: "radiogroup" }, options.map((o) =>
    h("button" + (o.value === value ? ".on" : ""), { role: "radio", "aria-checked": String(o.value === value), onclick: () => { if (o.value !== value) set(o.value); } }, o.label)));
}

export function spinner(): HTMLElement { return h("span.spinner"); }

/** "Downloading Kokoro voices… 42%" → 0.42; null when there's no number (indeterminate). */
export function percent(status: string): number | null {
  const m = /(\d+)%/.exec(status);
  return m ? Number(m[1]) / 100 : null;
}

export function progress(value: number | null): HTMLElement {
  const bar = h("div.progress" + (value === null ? ".indeterminate" : ""));
  bar.appendChild(h("div.progress-fill", { style: { width: value === null ? "30%" : `${Math.round(value * 100)}%` } }));
  return bar;
}

export function installProgress(status: string): HTMLElement {
  return h("div.install", null, progress(percent(status)), h("div.row-detail", null, status));
}

export function allowed(label = "Allowed"): HTMLElement {
  return h("span.allowed", null, icon("check", 15), label);
}

/** Runs `fn` now and every `ms` while the page is visible (the macOS windows only poll while on screen). */
export function poll(fn: () => Promise<void> | void, ms: number) {
  let busy = false;
  const tick = async () => {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try { await fn(); } catch {} finally { busy = false; }
  };
  setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
}

/** The project name: "Home" for VisionCLI Home, else the folder name. */
export function projectName(path: string, home: string): string {
  return path === home ? "Home" : path.split("/").filter(Boolean).pop() ?? path;
}
