// The Meeting Notes panel (MeetingPanel.swift): colleagues on the left, you on the right, a one-line summary under
// each turn, three reply chips under a colleague's question (click copies; the keyboard button types it where you
// were typing, never sending), "From the code" answers, and after the meeting its summary and a player that
// highlights the line being played. Main pushes `meeting:view`; actions go back on `meeting:action`.

import { vcli } from "../shared/bridge";
import { esc } from "../shared/markdown";

interface Row {
  id: number; speaker: "Guest" | "You"; start: number; text: string; open: boolean; summary: string | null; summarizing: boolean;
  question: boolean; replies: string[]; repliesLoading: boolean;
  lookup: { state: "looking" } | { state: "found"; text: string } | { state: "failed" } | null;
}
interface View {
  isOn: boolean; startedAt: number | null; rows: Row[]; guestSpeaking: boolean; youSpeaking: boolean; overview: string | null;
  finishing: boolean; mixing: boolean; project: string; projectLabel: string; engine: string; folder: string | null; audioUrl: string | null;
}

const head = document.getElementById("head")!;
const list = document.getElementById("list")!;
const playerEl = document.getElementById("player")!;
const audio = document.getElementById("audio") as HTMLAudioElement;
let view: View | null = null;
let follow = true;
let playing: number | null = null;

const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const elapsed = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`;
};
const act = (a: Record<string, unknown>) => vcli.send("meeting:action", a);

const ICON = {
  play: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/></svg>',
  follow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
};

function renderHead(v: View) {
  const timer = v.isOn && v.startedAt ? `<span class="dot"></span><span id="timer" class="mono">${elapsed((Date.now() - v.startedAt) / 1000)}</span>`
    : `<span class="ended">✓ Ended</span>`;
  const engine = v.isOn && v.engine ? `<span class="engine" title="Transcribing with ${esc(v.engine)}">≋</span>` : "";
  head.innerHTML = `${timer}
    <button class="project" data-a="projectMenu" title="Code questions are looked up in this project">${ICON.folder}<span>${esc(v.projectLabel)}</span></button>
    ${engine}<span class="spacer"></span>
    <button class="icon ${follow ? "on" : ""}" data-a="follow" title="${follow ? "Following the conversation" : "Not scrolling"}">${ICON.follow}</button>
    ${v.isOn ? `<button class="btn" data-a="stop">Stop</button>` : v.folder ? `<button class="btn" data-a="openNotes">Open Notes</button>` : ""}`;
}

function renderPlayer(v: View) {
  const show = !v.isOn && (v.mixing || !!v.audioUrl);
  playerEl.hidden = !show;
  if (!show) return;
  if (v.mixing) { playerEl.innerHTML = `<span class="muted">Saving the recording…</span>`; return; }
  if (audio.getAttribute("src") !== v.audioUrl) audio.src = v.audioUrl!;
  if (!playerEl.querySelector("input")) {
    playerEl.innerHTML = `<button class="icon" id="pp">${ICON.play}</button><input id="scrub" type="range" min="0" max="1" step="0.1" value="0"><span id="ptime" class="mono muted">0:00 / 0:00</span>`;
    const scrub = playerEl.querySelector<HTMLInputElement>("#scrub")!;
    scrub.addEventListener("input", () => { audio.currentTime = Number(scrub.value); });
    playerEl.querySelector("#pp")!.addEventListener("click", () => { if (audio.paused) void audio.play(); else audio.pause(); });
  }
}

function syncPlayer() {
  const pp = playerEl.querySelector("#pp"), scrub = playerEl.querySelector<HTMLInputElement>("#scrub"), t = playerEl.querySelector("#ptime");
  if (pp) pp.innerHTML = audio.paused ? ICON.play : ICON.pause;
  if (scrub) { scrub.max = String(audio.duration || 1); scrub.value = String(audio.currentTime); }
  if (t) t.textContent = `${elapsed(audio.currentTime)} / ${elapsed(audio.duration || 0)}`;
  // The line being played: the last one that started by now.
  if (!view?.startedAt) return;
  const started = view.startedAt;
  let id: number | null = null;
  for (const r of view.rows) if ((r.start - started) / 1000 <= audio.currentTime + 0.05) id = r.id;
  if (audio.currentTime === 0 && audio.paused) id = null;
  if (id === playing) return;
  playing = id;
  list.querySelectorAll(".row.playing").forEach((e) => e.classList.remove("playing"));
  if (id !== null) {
    const el = list.querySelector(`.row[data-id="${id}"]`);
    el?.classList.add("playing");
    if (follow) el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
for (const ev of ["timeupdate", "play", "pause", "loadedmetadata", "ended"]) audio.addEventListener(ev, syncPlayer);

function rowHtml(r: Row, v: View) {
  const guest = r.speaker === "Guest";
  const canPlay = !v.isOn && !!v.audioUrl;
  let extra = "";
  if (r.summary) extra += `<div class="summary">≡ ${esc(r.summary)}</div>`;
  else if (r.summarizing) extra += `<div class="summary faint">Summarizing…</div>`;
  if (guest && r.repliesLoading) extra += `<div class="chips">${[190, 150, 220].map((w) => `<div class="shimmer" style="width:${w}px"></div>`).join("")}</div>`;
  else if (guest && r.replies.length) {
    extra += `<div class="chips">${r.replies.map((t) => `<div class="chip-row"><button class="chip" data-a="copy" data-text="${esc(t)}">${ICON.reply}<span>${esc(t)}</span></button>
      <button class="icon type" data-a="type" data-text="${esc(t)}" title="Type it where you're typing (not sent)">${ICON.keyboard}</button></div>`).join("")}</div>`;
  }
  if (r.lookup) {
    const body = r.lookup.state === "looking" ? `<span class="muted">Looking in the project…</span>`
      : r.lookup.state === "failed" ? `<span class="muted">Couldn't find it in the code.</span>` : esc(r.lookup.text).replace(/\n/g, "<br>");
    extra += `<div class="code"><div class="code-title">${ICON.code} From the code</div><div class="code-body">${body}</div></div>`;
  }
  return `<div class="row ${guest ? "guest" : "you"}${playing === r.id ? " playing" : ""}" data-id="${r.id}">
    <div class="meta">${r.speaker} · ${clock(r.start)}${canPlay ? ` <button class="icon seek" data-a="seek" data-id="${r.id}" title="Play from here">▶</button>` : ""}</div>
    <div class="bubble${r.open ? " open" : ""}">${esc(r.text)}</div>${extra}</div>`;
}

function overviewHtml(md: string) {
  const lines = md.split("\n").filter((l) => l.trim());
  return `<div class="overview"><div class="ov-title">Meeting summary</div>${lines.map((l) => {
    if (/^#+\s/.test(l)) return `<div class="ov-h">${esc(l.replace(/^#+\s*/, ""))}</div>`;
    const item = /^\s*[-*•]\s+/.test(l);
    const text = esc(l.replace(/^\s*[-*•]\s+/, "")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    return `<div class="ov-l">${item ? "•&nbsp; " : ""}${text}</div>`;
  }).join("")}</div>`;
}

function render(v: View) {
  view = v;
  renderHead(v);
  renderPlayer(v);
  let html = "";
  if (v.overview) html += overviewHtml(v.overview);
  else if (v.finishing) html += `<div class="muted pad">Writing the meeting summary…</div>`;
  if (!v.rows.length && v.isOn) {
    html += `<div class="empty">Listening… What your colleagues say (your computer's sound) shows on the left, what you say (the microphone) on the right.${v.engine ? `<br>Transcribing with ${esc(v.engine)}.` : ""}</div>`;
  }
  html += v.rows.map((r) => rowHtml(r, v)).join("");
  if (v.isOn && (v.guestSpeaking || v.youSpeaking)) {
    html += `<div class="speaking ${v.guestSpeaking ? "guest" : "you"}"><span class="dots"><i></i><i></i><i></i></span>${v.guestSpeaking ? "Guest is speaking" : "You're speaking"}</div>`;
  }
  list.innerHTML = html;
  if (follow && v.isOn) list.scrollTop = list.scrollHeight;
}

document.body.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
  if (!b) return;
  const a = b.dataset.a!;
  if (a === "follow") { follow = !follow; if (view) renderHead(view); return; }
  if (a === "seek" && view?.startedAt) {
    const r = view.rows.find((x) => x.id === Number(b.dataset.id));
    if (r) { audio.currentTime = Math.max(0, (r.start - view.startedAt) / 1000 - 0.3); void audio.play(); }
    return;
  }
  if (a === "copy") {
    act({ type: "copy", text: b.dataset.text ?? "" });
    const span = b.querySelector("span");
    if (span) { const t = span.textContent; span.textContent = "Copied"; setTimeout(() => { span.textContent = t; }, 1200); }
    return;
  }
  if (a === "type") { act({ type: "type", text: b.dataset.text ?? "" }); return; }
  if (a === "projectMenu") { act({ type: "projectMenu", from: "panel" }); return; }
  act({ type: a });
});

setInterval(() => {
  const t = document.getElementById("timer");
  if (t && view?.isOn && view.startedAt) t.textContent = elapsed((Date.now() - view.startedAt) / 1000);
}, 1000);

vcli.on("meeting:view", (v: View) => render(v));
vcli.send("meeting:ready");
