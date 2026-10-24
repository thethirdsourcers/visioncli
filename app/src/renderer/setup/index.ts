import type { AssistantId, SettingsActionName, SettingsActions, SettingsSnapshot, SetupChecks, SetupStepId } from "../../main/ui/windows/types";
import { allowed, button, h, icon, installProgress, poll, progress, radioMark, segmented, spinner, toggle, type Child } from "../settings/ui";
import { back, missing, next, requiredDone, stateOf, STEPS, whisperDetail } from "./steps";

// The setup wizard (Setup.swift): one window that walks through every permission and download VisionCLI needs, one
// step at a time, with live status (a check as soon as main reports it). Each permission step shows main's check
// (what was found) and its fix action; the speech, voice and assistant steps use the same actions as Settings.

let step: SetupStepId = "welcome";
let checks: SetupChecks = {};
let s: SettingsSnapshot | null = null;
let fixing: SetupStepId | null = null;
let lastJSON = "";
/** Add-ons ticked in the Add-ons step (null until first shown: then every one not installed yet). */
let addOnsTicked: Set<string> | null = null;

function apply(r: { checks: SetupChecks; settings: SettingsSnapshot; step?: string }, force = false) {
  checks = r.checks ?? {};
  s = r.settings ?? s;
  const json = JSON.stringify([checks, s, step, fixing]);
  void window.vcli.invoke("setup:required", requiredDone(step, checks, s));
  if (force || json !== lastJSON) { lastJSON = json; render(); }
}

async function refresh(force = false) { apply(await window.vcli.invoke("setup:get"), force); }

function go(id: SetupStepId) {
  step = id;
  void window.vcli.invoke("setup:go", id);
  render(true);
}

async function act<K extends SettingsActionName>(name: K, value?: SettingsActions[K]) {
  const snap = await window.vcli.invoke("settings:action", { name, value });
  if (snap) { s = snap; render(); }
}

async function fix(id: SetupStepId) {
  fixing = id;
  render();
  try { apply(await window.vcli.invoke("setup:fix", id), true); } finally { fixing = null; render(); }
}

// ── Layout ──

function render(top = false) {
  const app = document.getElementById("app")!;
  const scroll = top ? 0 : app.querySelector(".content")?.scrollTop ?? 0;
  const sidebar = h("nav.sidebar.steps", null,
    h("div.steps-title", null, "Set up VisionCLI"),
    STEPS.map((x) => h("button.nav" + (x.id === step ? ".selected" : ""), { onclick: () => go(x.id) }, badge(x.id, x.icon), x.title)));
  const content = h("div.content", null, page());
  const meta = STEPS.find((x) => x.id === step)!;
  const st = stateOf(step, step, checks, s);
  const footer = h("div.footer", null,
    step !== "welcome" && button("Back", () => { const b = back(step); if (b) go(b); }),
    h("span.grow"),
    step === "done" ? button("Finish", () => window.vcli.invoke("setup:finish"), { primary: true })
      : button(st === "done" || step === "welcome" || meta.optional ? "Continue" : "Continue Anyway", () => { const n = next(step); if (n) go(n); }, { primary: true }));
  app.replaceChildren(h("div.split", null, sidebar, h("div.main", null, content, footer)));
  content.scrollTop = scroll;
}

function badge(id: SetupStepId, sym: string): Element {
  const st = stateOf(id, step, checks, s);
  if (st === "done") return h("span.badge.done", null, icon("check", 15));
  if (st === "optional") return h("span.badge.optional", null, icon("dotted", 15));
  return h("span.badge" + (id === step ? ".current" : ""), null, icon(sym, 15));
}

function header(title: string, subtitle: string): HTMLElement {
  const meta = STEPS.find((x) => x.id === step)!;
  return h("div.step-header", null, h("span.step-icon", null, icon(meta.icon, 28)), h("h1", null, title), h("p", null, subtitle));
}

const note = (text: string) => h("p.note.spaced", null, text);

/** A permission step: "Allowed" once main's check passes, else the fix button; what was found, and how to do it by hand. */
function permission(id: SetupStepId, extra?: Child): Child {
  const c = checks[id];
  const done = c?.state === "done";
  const busy = fixing === id || c?.busy;
  return [
    h("div.permission", null,
      done ? allowed() : busy ? h("span.busy", null, spinner(), "Working…") : c?.fix ? button(c.fix, () => fix(id), { large: true, primary: true }) : null,
      c?.detail ? h("span.found" + (done ? "" : ".pending"), null, c.detail) : !c ? h("span.found", null, spinner(), "Checking…") : null),
    c?.note && note(c.note),
    c?.command && !done && h("div.command", null, h("code.selectable", null, c.command),
      h("button.icon-button", { title: "Copy", onclick: () => window.vcli.invoke("setup:copy", c.command) }, icon("copy", 15))),
    extra ?? null,
  ];
}

function keyRow(keys: string, text: string): HTMLElement {
  return h("div.key-row", null, h("span.keys", null, keys), h("span", null, text));
}

function choice(selected: boolean, title: string, detail: string, action: () => void): HTMLElement {
  return h("div.choice", { onclick: () => { if (!selected) action(); } }, radioMark(selected),
    h("div", null, h("div.choice-title", null, title), h("div.choice-detail", null, detail)));
}

// Windows calls Super the Windows key, and any app may read the keyboard there (no input group).
const WINDOWS = navigator.userAgent.includes("Windows");
const SUPER = WINDOWS ? "Win" : "Super";

function page(): Child {
  // The keys chosen in Settings → Shortcuts (Alt, Alt+Super and Alt+Shift+Space by default).
  const hold = s?.shortcuts.holdName ?? "Alt";
  const keys = (k: string) => k.split("+").join(" ");
  switch (step) {
    case "welcome":
      return [
        header("Welcome to VisionCLI", "Ask Claude about anything on your screen, out loud. This takes about a minute."),
        h("div.keys-list", null,
          keyRow(hold, `Hold ${hold}, ask, let go: the answer appears in the corner.`),
          keyRow(keys(s?.shortcuts.screenKeys ?? `Alt+${SUPER}`), "Hold both to include a screenshot of the window."),
          keyRow(keys(s?.shortcuts.list.find((x) => x.id === "point")?.keys ?? "Alt+Shift+Space"), "Drag a box around what you mean.")),
        h("div.mascot", null, h("img", { src: "../../assets/mascot/peek.png", alt: "", onerror: (e: Event) => (e.target as HTMLElement).remove() })),
      ];
    case "microphone":
      return [header("Microphone", `VisionCLI listens only while you hold ${hold}.`), permission("microphone", s && s.inputs.length > 0 && h("div.inline-row", null,
        h("span", null, "Microphone"),
        selectDevice()))];
    case "keyboard":
      return [header("Keyboard Access", WINDOWS ? `Lets VisionCLI notice when you hold ${hold}, in every app.` : `Lets VisionCLI notice when you hold ${hold}, on X11 and Wayland. Linux lets only members of the input group read the keyboard.`), permission("keyboard")];
    case "screen":
      return [header("Screen Capture", "Lets VisionCLI see the window you're asking about. It only looks when you ask."), permission("screen")];
    case "control":
      return [header("Computer Control", "Lets VisionCLI click and type for you when you ask it to, and find buttons and fields through accessibility (AT-SPI)."), permission("control")];
    case "terminal":
      return [header("Terminal", "Optional: lets VisionCLI type your spoken questions into Claude in your terminal. Works with tmux, kitty and WezTerm; otherwise VisionCLI opens its own terminal."), permission("terminal")];
    case "transcription": return transcription();
    case "voice": return voice();
    case "assistant": return assistant();
    case "addons": return addOns();
    case "done": {
      const left = missing(step, checks, s);
      return [
        header("You're all set", `Hold ${hold} and ask "what is this?" while pointing at anything on your screen.`),
        left.length > 0 && note(`Still to do: ${left.map((x) => x.title).join(", ")}. Reopen this from the VisionCLI menu → Settings… → General → Setup Wizard.`),
      ];
    }
  }
}

function selectDevice(): HTMLElement {
  const sel = h("select", { onchange: (e: Event) => act("setAudioDevice", { input: true, id: (e.target as HTMLSelectElement).value || null }) },
    h("option", { value: "" }, `System default (${s!.defaultInput})`),
    s!.inputs.map((d) => h("option", { value: d.id }, d.name)));
  sel.value = s!.inputDevice && s!.inputs.some((d) => d.id === s!.inputDevice) ? s!.inputDevice : "";
  return sel;
}

function transcription(): Child {
  const out: Child[] = [header("Speech Model", "How your voice becomes text. You can change it later in the VisionCLI menu → Settings… → Voice.")];
  if (!s) return out;
  const engine = s.speechEngine;
  const list: Child[] = [];
  if (s.hasParakeet) list.push(choice(engine === "parakeet", "Parakeet (recommended)", "Most accurate, runs on your computer, knows your project's names. " + (s.parakeetDownloaded ? "Already on your computer." : "Downloads about 540 MB once."), () => act("chooseSpeech", "parakeet")));
  for (const m of s.whisperModels) list.push(choice(engine === `whisper:${m}`, `Whisper ${m}`, whisperDetail(m), () => act("chooseSpeech", `whisper:${m}`)));
  if (!s.whisperModels.length) list.push(choice(engine.startsWith("whisper"), "Whisper", "Runs on your computer, good with accents. Downloads about 490 MB.", () => act("chooseSpeech", "whisper:small.en")));
  if (s.systemSpeech) list.push(choice(engine === "system", "System (built in)", "No download. Less accurate with code words and names.", () => act("chooseSpeech", "system")));
  out.push(h("div.choices", null, list));
  if (engine.startsWith("whisper") && !s.whisperModels.length) {
    out.push(s.installStatus ? installProgress(s.installStatus) : h("div.spaced", null, button("Download Whisper", () => act("installWhisper"))));
  }
  if (engine === "parakeet") {
    if (s.parakeetReady) out.push(h("div.spaced", null, allowed("Parakeet is ready.")));
    else if (s.parakeetProgress !== null) {
      const p = s.parakeetProgress;
      out.push(h("div.install.spaced", null, progress(p), h("div.row-detail", null, p < 0.98 ? `Downloading Parakeet… ${Math.round(p * 100)}%` : "Preparing the model…")));
    } else out.push(h("div.spaced", null, button("Download Parakeet", () => act("chooseSpeech", "parakeet"))));
  }
  return out;
}

function voice(): Child {
  const out: Child[] = [header("Voice", "VisionCLI can read short answers aloud. Pick a voice; you'll hear a sample.")];
  if (!s) return out;
  out.push(h("label.inline-row", null, toggle(s.speak, (on) => act("setSpeak", on)), "Read answers aloud"));
  if (s.speak) {
    out.push(h("div.spaced", null, segmented(String(s.speed), [1, 1.25, 1.5, 2].map((x) => ({ value: String(x), label: `${x}×` })), (v) => act("setSpeed", Number(v)))));
  }
  const voiceRow = (id: string | null, label: string) => h("div.voice-row.narrow", { onclick: () => { if (!s!.speak) void act("setSpeak", true); void act("selectVoice", id); } },
    radioMark(s!.voice === id), h("span.label", null, label), h("span.muted-icon", null, icon("play", 16)));
  out.push(h("div.voices", null, s.kokoroVoices.map((v) => voiceRow(v.id, `Kokoro · ${v.name}`)), voiceRow(null, "System voice (speech-dispatcher)")));
  if (!s.kokoroInstalled) {
    out.push(s.installStatus ? installProgress(s.installStatus)
      : [h("div.spaced", null, button("Download Natural Voices (~340 MB)", () => act("installKokoro"))), note("Seven natural-sounding voices (US and UK) that run on your computer.")]);
  }
  return out;
}

function assistant(): Child {
  const out: Child[] = [header("Assistant", "Pick the AI that answers your voice questions. VisionCLI's tools (look, click, browser…) are connected to it, so they also work when you type.")];
  if (!s) return out;
  const snap = s;
  const status = (a: AssistantId): Child => {
    const t = snap.tools[a];
    if (t.connecting) return h("span.status", null, spinner(), "Connecting…");
    if (t.connected) return h("span.status.ok", null, icon("check", 13), "Tools connected");
    if (t.error) return h("span.status.err", null, t.error, button("Try Again", () => act("connectTools", a)));
    if (t.connected === false) return button("Connect Tools", () => act("connectTools", a));
    return null;
  };
  const row = (a: AssistantId, title: string, detail: string, install: string) => {
    const installed = snap.installed[a];
    return h("div.choice" + (installed ? "" : ".disabled"), {
      onclick: () => {
        if (!installed || snap.assistant === a) return;
        void act("setAssistant", a);
        // Its tools are needed for voice questions: connect right away if they aren't yet.
        if (!snap.tools[a].connected) void act("connectTools", a);
      },
    }, radioMark(snap.assistant === a), h("div", null,
      h("div.choice-title", null, title + (installed ? "" : " (not installed)")),
      h("div.choice-detail", null, installed ? detail : install),
      installed && status(a)));
  };
  out.push(h("div.choices", null,
    row("claude", "Claude Code", "Anthropic's Claude in your terminal.", "Install from claude.com/claude-code, then run `claude` once to sign in."),
    row("antigravity", "Gemini (Antigravity)", "Google's Gemini through the Antigravity CLI.", "Install Antigravity from antigravity.google, then run `agy` once to sign in.")));
  out.push(h("h3.sub", null, "Answers appear"));
  out.push(h("div.choices.tight", null,
    choice(snap.terminalMode, "In your terminal", "Type or talk, same conversation.", () => act("setTerminalMode", true)),
    choice(!snap.terminalMode, "Only in the bubble", "Lighter.", () => act("setTerminalMode", false))));
  if (snap.installed.gemini) {
    out.push(h("h3.sub", null, "Also connect the tools to"), h("div.inline-row", null, h("span", null, "Gemini CLI"), status("gemini")));
  }
  return out;
}

/** The recommended add-ons for Claude Code, ticked unless already installed, and one button to install them. */
function addOns(): Child {
  const out: Child[] = [header("Add-ons for Claude Code", "Optional plugins that make Claude better at everyday coding. The ticked ones are installed for all your projects; you can change this later in Settings → Integrations.")];
  if (!s) return out;
  const list = s.addOns;
  const ticked = (addOnsTicked ??= new Set(list.filter((a) => !a.installed).map((a) => a.id)));
  const claude = s.installed.claude;
  out.push(h("div.choices", null, list.map((a) => h("label.choice" + (a.installed || !claude ? ".disabled" : ""), null,
    h("input", { type: "checkbox", style: { marginTop: "3px" }, checked: a.installed || ticked.has(a.id), disabled: a.installed || !claude,
      onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) ticked.add(a.id); else ticked.delete(a.id); render(); } }),
    h("div", null, h("div.choice-title", null, a.title), h("div.choice-detail", null, a.detail),
      a.error && h("div.status.err", null, a.error)),
    h("span", { style: { marginLeft: "auto", flex: "none" } }, a.installed ? h("span.status.ok", null, icon("check", 13), "Installed") : a.installing ? spinner() : null)))));
  if (!claude) out.push(note("Install Claude Code first (claude.com/claude-code)."));
  else {
    const todo = list.filter((a) => ticked.has(a.id) && !a.installed).map((a) => a.id);
    const busy = list.some((a) => a.installing);
    out.push(h("div.spaced", null, button(busy ? "Installing…" : "Install Selected", () => act("installAddOns", todo), { large: true, primary: true, disabled: !todo.length || busy })));
  }
  return out;
}

// ── Wiring ──

window.vcli.on("settings:snapshot", (snap: SettingsSnapshot) => { s = snap; render(); });
window.vcli.on("setup:step", (id: SetupStepId) => { if (STEPS.some((x) => x.id === id)) go(id); });
window.vcli.on("setup:refresh", () => void refresh());
// Re-reads every status: the user changes things elsewhere (a portal dialog, a terminal) while the window is open.
poll(() => refresh(), 700);
void (async () => {
  const r = await window.vcli.invoke("setup:get");
  const saved = (r.step as SetupStepId) ?? "welcome";
  step = STEPS.some((x) => x.id === saved) ? saved : "welcome";
  apply(r, true);
})();
