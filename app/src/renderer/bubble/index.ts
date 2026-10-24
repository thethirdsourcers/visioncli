// The overlay bubble (Views.swift OverlayView): the listening / thinking pill that rides the pointer, the answer
// bubble (scrollable, with its toolbar) and the approval card. Main sends the whole OverlayState on "overlay:state";
// buttons and links go back as BubbleActions on "overlay:action"; the content's size goes to "overlay:size".

import type { BubbleAction, OverlayState } from "../../main/contracts";
import { reportSize, vcli } from "../shared/bridge";
import { icons } from "../shared/icons";
import { answerSegments, diffLines, esc, hasFileRef, renderText } from "../shared/markdown";
import { diagramBlock } from "../shared/mermaid";
import { spinner } from "../shared/spinner";

const root = document.getElementById("root")!;
const act = (a: BubbleAction) => vcli.send("overlay:action", a);

type View = "none" | "listening" | "thinking" | "answer" | "approval";
let view: View = "none";
let s: OverlayState | null = null;

function viewFor(st: OverlayState): View {
  switch (st.phase) {
    case "listening": return "listening";
    case "thinking": return "thinking";
    case "answering": case "done": case "error": return "answer";
    case "approval": return st.approval ? "approval" : "none";
    default: return "none";
  }
}

// ── Pill ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const BAR_WEIGHTS = [0.5, 0.8, 1, 0.75, 0.45];

function buildPill(leading: string) {
  root.innerHTML = `<div class="pill"><div class="leading">${leading}</div>
    <div class="texts"><div class="text"></div><div class="badge"></div></div></div>`;
}

function updatePill(text: string, placeholder: string, badge: string) {
  const t = root.querySelector<HTMLElement>(".pill .text")!;
  t.textContent = text || placeholder;
  t.classList.toggle("placeholder", !text);
  // lineLimit(2) with truncationMode(.head): a long live caption keeps its latest words.
  if (text && t.scrollHeight > t.clientHeight + 1) {
    const words = text.split(" ");
    while (words.length > 1 && t.scrollHeight > t.clientHeight + 1) { words.shift(); t.textContent = "…" + words.join(" "); }
  }
  const b = root.querySelector<HTMLElement>(".pill .badge")!;
  b.innerHTML = badge;
  b.hidden = !badge;
}

function updateBars(level: number) {
  root.querySelectorAll<HTMLElement>(".bars i").forEach((bar, i) => {
    bar.style.height = `${4 + 16 * Math.min(1, level * BAR_WEIGHTS[i])}px`;
  });
}

// ── Answer bubble ──────────────────────────────────────────────────────────────────────────────────────────────────

function buildAnswer() {
  root.innerHTML = `<div class="bubble">
    <div class="header"><span class="state"></span><span class="question"></span><span class="spacer"></span><span class="project"></span></div>
    <div class="scroll"><div class="answer"></div></div>
    <div class="toolbar">
      <button class="icon-btn" data-act="copy" title="Copy answer">${icons.copy}</button>
      <button class="icon-btn" data-act="speak" title="Read aloud"></button>
      <button class="icon-btn" data-act="history" title="History">${icons.history}</button>
      <span class="spacer"></span><span class="toast"></span>
      <button class="icon-btn" data-act="openFirst">${icons.open}</button>
      <button class="icon-btn" data-act="pin"></button>
      <button class="icon-btn" data-act="close" title="Close (esc)">${icons.close}</button>
    </div></div>`;
  const bubble = root.querySelector<HTMLElement>(".bubble")!;
  bubble.addEventListener("mouseenter", () => act({ type: "hover", inside: true }));
  bubble.addEventListener("mouseleave", () => act({ type: "hover", inside: false }));
}

let lastStateIcon = "";

function updateAnswer(st: OverlayState) {
  const bubble = root.querySelector<HTMLElement>(".bubble")!;
  bubble.classList.toggle("pinned", st.pinned);
  const stateIcon = st.phase === "answering" ? "spin" : st.phase === "error" ? "error" : "mark";
  if (stateIcon !== lastStateIcon) {
    lastStateIcon = stateIcon;
    const el = root.querySelector<HTMLElement>(".header .state")!;
    el.className = `state ${stateIcon}`;
    el.innerHTML = stateIcon === "spin" ? spinner(13) : stateIcon === "error" ? icons.warning : icons.mark;
  }
  root.querySelector<HTMLElement>(".header .question")!.textContent = st.question;
  const project = root.querySelector<HTMLElement>(".header .project")!;
  project.textContent = st.project ?? "";
  project.hidden = !st.project;

  const { answer, segments } = answerSegments(st.raw);
  const box = root.querySelector<HTMLElement>(".answer")!;
  // Keyed update: unchanged segments (and rendered diagrams) stay as they are while the answer streams.
  segments.forEach((seg, i) => {
    const key = seg.type === "text" ? `t:${i}` : seg.type === "mermaid" ? "m:" + seg.code : `p:${i}`;
    let el = box.children[i] as HTMLElement | undefined;
    if (el && el.dataset.key !== key) { while (box.children.length > i) box.lastElementChild!.remove(); el = undefined; }
    if (!el) {
      if (seg.type === "mermaid") el = diagramBlock(seg.code);
      else {
        el = document.createElement("div");
        el.className = seg.type === "text" ? "text" : "pending";
        if (seg.type === "pendingDiagram") el.innerHTML = `${spinner(14)}<span>Drawing diagram…</span>`;
      }
      el.dataset.key = key;
      box.appendChild(el);
    }
    if (seg.type === "text") {
      const html = renderText(seg.text);
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    }
  });
  while (box.children.length > segments.length) box.lastElementChild!.remove();

  const toolbar = root.querySelector<HTMLElement>(".toolbar")!;
  toolbar.hidden = !(st.pinned || st.phase === "done" || st.phase === "error");
  const speak = toolbar.querySelector<HTMLElement>('[data-act="speak"]')!;
  speak.innerHTML = st.speaking ? icons.speakerFill : icons.speaker;
  speak.classList.toggle("active", st.speaking);
  const pin = toolbar.querySelector<HTMLElement>('[data-act="pin"]')!;
  pin.innerHTML = st.pinned ? icons.pinSlash : icons.pin;
  pin.title = `${st.pinned ? "Unpin" : "Pin"} (${st.keys.pin})`;
  pin.classList.toggle("active", st.pinned);
  const open = toolbar.querySelector<HTMLElement>('[data-act="openFirst"]')!;
  open.hidden = !hasFileRef(answer);
  open.title = `Open file (${st.keys.open})`;
  const toast = toolbar.querySelector<HTMLElement>(".toast")!;
  toast.textContent = st.toast ?? "";
  toast.hidden = !st.toast;
}

// ── Approval card ──────────────────────────────────────────────────────────────────────────────────────────────────

function renderApproval(st: OverlayState) {
  const req = st.approval!;
  const lines = diffLines(req.preview);
  const prefix = { added: "+ ", removed: "- ", context: "  " };
  root.innerHTML = `<div class="approval">
    <div class="title-row"><span class="hand">${icons.hand}</span><span class="title">${esc(req.summary)}</span>
      <span class="spacer"></span>${st.project ? `<span class="project">${esc(st.project)}</span>` : ""}</div>
    ${req.tool ? `<div class="tool">${esc(req.tool)}</div>` : ""}
    ${lines.length ? `<div class="diff">${lines.map((l) => `<div class="${l.kind}">${esc(prefix[l.kind] + l.text)}</div>`).join("")}</div>` : ""}
    <div class="buttons">
      <button class="capsule-btn primary" data-approve="allow">Allow&nbsp;&nbsp;${esc(st.keys.allow)}</button>
      <button class="capsule-btn outline" data-approve="allowAll">Allow all this session</button>
      <span class="spacer"></span>
      ${req.queue > 0 ? `<span class="queue">${req.queue} more waiting</span>` : ""}
      <button class="deny" data-approve="deny">Deny&nbsp;&nbsp;esc</button>
    </div></div>`;
}

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────────────────────────────

root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const link = t.closest("a");
  if (link) {
    e.preventDefault();
    const href = link.getAttribute("href");
    if (href) act({ type: "link", url: href });
    return;
  }
  const btn = t.closest<HTMLElement>("[data-act]");
  if (btn) { act({ type: btn.dataset.act as "copy" }); return; }
  const ap = t.closest<HTMLElement>("[data-approve]");
  if (ap) act({ type: "approve", answer: ap.dataset.approve as "allow" | "allowAll" | "deny" });
});

let lastApproval = "";

function render(st: OverlayState) {
  s = st;
  const v = viewFor(st);
  document.body.dataset.phase = st.phase;
  if (v !== view) {
    view = v;
    lastStateIcon = "";
    lastApproval = "";
    if (v === "none") root.innerHTML = "";
    if (v === "listening") buildPill(`<span class="bars">${"<i></i>".repeat(5)}</span>`);
    if (v === "thinking") buildPill(spinner(22));
    if (v === "answer") buildAnswer();
  }
  if (v === "listening") {
    updateBars(st.level);
    updatePill(st.live || st.question, st.status || "Listening…", st.screenshot ? `${icons.camera}<span>with screenshot</span>` : "");
  } else if (v === "thinking") {
    updatePill(st.status, "Thinking…", st.project ? esc(st.project) : "");
  } else if (v === "answer") {
    updateAnswer(st);
  } else if (v === "approval") {
    const key = JSON.stringify([st.approval, st.project]);
    if (key !== lastApproval) { lastApproval = key; renderApproval(st); }
  }
}

vcli.on("overlay:state", (st: OverlayState) => render(st));
// The mic level arrives far more often than the rest of the state: just move the bars.
vcli.on("overlay:level", (level: number) => { if (s) s.level = level; if (view === "listening") updateBars(level); });
reportSize(root, "overlay:size");
