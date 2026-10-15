// The Meeting Notes launcher (MeetingLauncher.swift): a card in the middle of the screen, opened by the shortcut.
// Before a meeting: the options (the same as Settings → Meeting Notes), the project code questions are looked up in,
// ⏎ Start / Esc Cancel. While one runs: the timer, Show Notes (⏎), Stop and Cancel.

import { reportSize, vcli } from "../shared/bridge";
import { esc } from "../shared/markdown";

interface Model {
  running: boolean; startedAt: number | null; shortcut: string; project: string; projectLabel: string;
  options: { summarizeGuest: boolean; summarizeYou: boolean; replies: boolean; codeLookup: boolean; record: boolean; hide: boolean; canHide: boolean };
}

const root = document.getElementById("root")!;
let m: Model | null = null;
const act = (a: Record<string, unknown>) => vcli.send("launcher:action", a);
const two = (n: number) => String(n).padStart(2, "0");
const elapsed = (s: number) => { const t = Math.max(0, Math.floor(s)); return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`; };

const SWITCHES: [keyof Model["options"], string][] = [
  ["summarizeGuest", "Summarize what colleagues say"],
  ["summarizeYou", "Summarize what you say"],
  ["replies", "Suggest replies when you're asked something"],
  ["codeLookup", "Answer code questions from the project"],
  ["record", "Record the meeting"],
  ["hide", "Hide VisionCLI from screen sharing"],
];

function render() {
  if (!m) return;
  const o = m.options;
  const sub = m.running && m.startedAt
    ? `<div class="sub mono" id="timer">Recording · ${elapsed((Date.now() - m.startedAt) / 1000)}</div>`
    : `<div class="sub">Your colleagues (your computer's sound) and you (the microphone), transcribed on this computer.</div>`;
  const body = m.running ? "" : `
    <div class="switches">${SWITCHES.filter(([k]) => k !== "hide" || o.canHide).map(([k, label]) =>
      `<label class="sw"><input type="checkbox" data-k="${k}" ${o[k] ? "checked" : ""}><span class="track"><span class="knob"></span></span>${esc(label)}</label>`).join("")}</div>
    <div class="project"><button class="link" data-a="projectMenu">📁 ${esc(m.projectLabel)}</button><span class="muted">for code questions</span></div>
    <div class="note">Where the law or your company's rules require it, tell the people in the meeting.</div>`;
  const buttons = m.running
    ? `<button class="btn" data-a="cancel">Cancel</button><button class="btn" data-a="stop">Stop</button><button class="btn primary" data-a="showNotes">Show Notes</button>`
    : `<button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="start">Start</button>`;
  root.innerHTML = `<div class="card">
    <div class="top"><div class="rec"><span></span></div><div><div class="title">${m.running ? "Meeting Notes is on" : "Start Meeting Notes"}</div>${sub}</div></div>
    ${body}
    <div class="foot"><span class="hint">${m.running ? esc(m.shortcut) : "⏎ to start · Esc to cancel"}</span><span class="spacer"></span>${buttons}</div></div>`;
}

root.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
  if (b) act({ type: b.dataset.a, ...(b.dataset.a === "projectMenu" ? { from: "launcher" } : {}) });
});
root.addEventListener("change", (e) => {
  const i = e.target as HTMLInputElement;
  if (!i.dataset.k || !m) return;
  (m.options as any)[i.dataset.k] = i.checked;
  act({ type: "setOption", key: i.dataset.k, value: i.checked });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") act({ type: "cancel" });
  else if (e.key === "Enter" && m) act({ type: m.running ? "showNotes" : "start" });
});
setInterval(() => {
  const t = document.getElementById("timer");
  if (t && m?.running && m.startedAt) t.textContent = `Recording · ${elapsed((Date.now() - m.startedAt) / 1000)}`;
}, 1000);

vcli.on("launcher:model", (model: Model) => { m = model; render(); });
reportSize(root, "launcher:size");
vcli.send("launcher:ready");
