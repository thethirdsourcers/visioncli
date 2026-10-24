import type { AssistantId, ResourceUsageView, SettingsActionName, SettingsActions, SettingsSection, SettingsSnapshot } from "../../main/ui/windows/types";
import {
  allowed, button, card, h, icon, installProgress, poll, progress, radioMark, radioRow, row, segmented, select, spinner, switchRow, tile,
  type Child, type Option,
} from "./ui";

// The Settings window (SettingsWindow.swift): a sidebar of sections, each a page of grouped rows. Changes apply
// immediately; every control calls settings:action and the page redraws from the snapshot main sends back.

const SECTIONS: { id: SettingsSection; title: string; subtitle: string; icon: string; tint: string }[] = [
  { id: "general", title: "General", subtitle: "Startup, updates and screenshots.", icon: "gear", tint: "#8e8e93" },
  { id: "assistant", title: "Assistant", subtitle: "Which AI answers your voice questions, where answers appear, and how hard it thinks.", icon: "sparkles", tint: "#af52de" },
  { id: "voice", title: "Voice", subtitle: "How your voice becomes text, and how answers are read back to you.", icon: "waveform", tint: "#ff2d55" },
  { id: "control", title: "Computer Control", subtitle: "Let the assistant click and type for you, with your approval.", icon: "cursor", tint: "#007aff" },
  { id: "meetings", title: "Meeting Notes", subtitle: "Notes, summaries and suggested replies in your meetings, with a recording to play back.", icon: "people", tint: "#ff9500" },
  { id: "integrations", title: "Integrations", subtitle: "Connect VisionCLI's tools (look, click, browser…) to your AI command-line tools.", icon: "puzzle", tint: "#34c759" },
  { id: "usage", title: "Usage", subtitle: "Memory, CPU and disk used by VisionCLI, its voices and speech models.", icon: "gauge", tint: "#30b0c7" },
  { id: "advanced", title: "Advanced", subtitle: "Permissions, logs and files.", icon: "wrench", tint: "#737373" },
];

const APP_NAMES: Record<AssistantId, string> = { claude: "Claude Code", antigravity: "Gemini (Antigravity)", gemini: "Gemini CLI" };
const SHORT_NAMES: Record<AssistantId, string> = { claude: "Claude", antigravity: "Gemini", gemini: "Gemini" };

let s: SettingsSnapshot | null = null;
let section: SettingsSection = (new URLSearchParams(location.search).get("section") as SettingsSection) || "general";
let lastJSON = "";

async function act<K extends SettingsActionName>(name: K, value?: SettingsActions[K]) {
  const next = await window.vcli.invoke("settings:action", { name, value });
  if (next) show(next);
}

function show(next: SettingsSnapshot, force = false) {
  const json = JSON.stringify(next);
  if (!force && json === lastJSON) return;
  lastJSON = json;
  s = next;
  render();
}

function choose(id: SettingsSection) {
  if (id === section) return;
  section = id;
  recording = null;
  void window.vcli.invoke("settings:section", id);
  render(true);
  void refreshUsage();
}

// ── Layout ──

function render(top = false) {
  if (!s) return;
  const meta = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const app = document.getElementById("app")!;
  const oldPage = app.querySelector(".page");
  const scroll = top ? 0 : oldPage?.scrollTop ?? 0;
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const sidebar = h("nav.sidebar", null,
    h("div.appinfo", null, h("img", { src: "../../assets/logo.png", alt: "" }),
      h("div", null, h("div.appname", null, "VisionCLI"), h("div.appversion", null, `Version ${s.version}`))),
    SECTIONS.map((x) => h("button.nav" + (x.id === section ? ".selected" : ""), { onclick: () => choose(x.id), "data-key": "nav-" + x.id },
      tile(x.icon, x.tint, 20), x.title)));
  const page = h("main.page", null,
    h("div.header", null, tile(meta.icon, meta.tint, 34), h("div", null, h("h1", null, meta.title), h("p", null, meta.subtitle))),
    PAGES[meta.id](s));
  app.replaceChildren(h("div.split", null, sidebar, page));
  page.scrollTop = scroll;
  document.title = "VisionCLI Settings";
  if (focusedId) (app.querySelector(`[data-key="${focusedId}"]`) as HTMLElement | null)?.focus();
}

// ── Pages ──

const PAGES: Record<SettingsSection, (s: SettingsSnapshot) => Child> = {
  general: (s) => [
    card("Project", "Questions, terminals and Meeting Notes' code answers use this project until you pick another.", [
      row("Project", null, select(s.project, s.projectChoices.map((c) => ({ value: c.id, label: c.name })), (v) => act("pickProject", v))),
      row("Another folder", null, button("Choose Folder…", () => act("chooseProjectFolder"))),
    ]),
    card(null, null, [
      switchRow("Start at login", "Opens VisionCLI when you log in.", s.startAtLogin, (on) => act("setStartAtLogin", on)),
      switchRow("Screenshot every question",
        `Sends a screenshot of the window with every voice question (uses more tokens). Off: only when you hold ${s.shortcuts.screenKeys} or drag a box; the assistant can still take a look itself.`,
        s.screenshotEvery, (on) => act("setScreenshotEvery", on)),
      switchRow("Spot errors in the terminal", `When an error shows up in a terminal pane (tmux, kitty or WezTerm), offers ${keysOf(s, "fix")} to have the assistant explain and fix it.`,
        s.errorWatcher, (on) => act("setErrorWatcher", on)),
    ]),
    shortcutsCard(s),
    card("Updates", null, [
      row(`VisionCLI ${s.version}`, s.updateStatus ?? (s.updateAvailable ? `Version ${s.updateAvailable} is available.` : "Checks GitHub for new releases."),
        s.updateStatus ? spinner()
          : s.updateAvailable ? button("Install Update…", () => act("installUpdate"))
          : button("Check Now", () => act("checkForUpdates"))),
      switchRow("Check for updates automatically", "At launch and every 6 hours.", s.autoUpdate, (on) => act("setAutoUpdate", on)),
    ]),
    card("Setup", null, [
      row("Setup wizard", "Walks through permissions, the speech model, voice and assistant again.",
        button("Open Setup Wizard…", () => void window.vcli.invoke("settings:openSetup"))),
    ]),
  ],

  assistant: (s) => {
    const assistantRow = (a: AssistantId, detail: string, install: string) => {
      const installed = s.installed[a];
      return radioRow(APP_NAMES[a] + (installed ? "" : " (not installed)"), installed ? detail : install, s.assistant === a, () => {
        void act("setAssistant", a);
        if (a === "antigravity" && !s.agyModels.length) void act("refreshAgyModels");
      }, installed);
    };
    const name = SHORT_NAMES[s.assistant];
    return [
      card(null, "A terminal already running claude or agy is used as-is when you point at it.", [
        assistantRow("claude", "Anthropic's Claude in your terminal.", "Install from claude.com/claude-code, then run claude once to sign in."),
        assistantRow("antigravity", "Google's Gemini through the Antigravity CLI.", "Install Antigravity from antigravity.google, then run agy once to sign in."),
      ]),
      card("Answers appear", null, [
        radioRow(`In your ${name} terminal`, "Type or talk, same conversation. Answers show in the terminal and the bubble.", s.terminalMode, () => act("setTerminalMode", true)),
        radioRow("Only in the bubble", "A hidden, leaner session in the background. It can't approve commands or edits.", !s.terminalMode, () => act("setTerminalMode", false)),
        !s.terminalMode && switchRow("Open the activity terminal automatically", "Shows what the assistant is doing on the first question after launch.", s.autoActivity, (on) => act("setAutoActivity", on)),
      ]),
      card("Model", null, [
        modelRow(s),
        row("Effort", "Higher is slower but more thorough. Default leaves it to the CLI's own setting.",
          select(s.effort ?? "", [{ value: "", label: "Default" }, ...s.efforts.map((e) => ({ value: e.id, label: e.name }))], (v) => act("setEffort", v || null))),
        switchRow("Fast model for simple questions",
          `Jev sends light questions like "what is this?" to ${s.assistant === "antigravity" ? "Gemini Flash" : "Claude Haiku"} and the rest to your model.` + (s.terminalMode ? " Only when answers appear in the bubble." : ""),
          s.smartRouting, (on) => act("setSmartRouting", on), s.terminalMode),
      ]),
    ];
  },

  voice: (s) => {
    const voiceRow = (id: string | null, label: string) =>
      h("div.voice-row", { onclick: () => act("selectVoice", id) },
        radioMark(s.voice === id), h("span.label", null, label),
        h("button.icon-button", { title: "Play a sample", onclick: (e: Event) => { e.stopPropagation(); void act("selectVoice", id); } }, icon("play", 17)));
    const speeds: Option[] = [1, 1.25, 1.5, 1.75, 2].map((x) => ({ value: String(x), label: `${x}×` }));
    const devicePicker = (input: boolean) => {
      const devices = input ? s.inputs : s.outputs;
      const chosen = input ? s.inputDevice : s.outputDevice;
      const current = chosen && devices.some((d) => d.id === chosen) ? chosen : "";
      return select(current, [
        { value: "", label: `System default (${input ? s.defaultInput : s.defaultOutput})` },
        ...devices.map((d, i) => ({ value: d.id, label: d.name, divider: i === 0 })),
      ], (v) => act("setAudioDevice", { input, id: v || null }));
    };
    const disconnected = (chosen: string | null, list: { id: string }[], what: string) =>
      chosen && !list.some((d) => d.id === chosen) ? `The chosen ${what} is disconnected; using the default.` : null;
    const speech: Child[] = [];
    if (s.hasParakeet) {
      speech.push(radioRow("Parakeet", "Local and fastest. Knows your project's names." + (s.parakeetDownloaded ? "" : " Downloads about 540 MB on first use."),
        s.speechEngine === "parakeet", () => act("chooseSpeech", "parakeet"), true,
        // While it downloads the engine is still the old one: show the bar whenever a download runs.
        s.parakeetProgress != null || (s.speechEngine === "parakeet" && !s.parakeetReady) ? parakeetProgress(s) : null));
    }
    for (const m of s.whisperModels) speech.push(radioRow(`Whisper ${m}`, "Local. Good with accents.", s.speechEngine === `whisper:${m}`, () => act("chooseSpeech", `whisper:${m}`)));
    if (s.systemSpeech) speech.push(radioRow("System", "On-device, no download. Less accurate with code words and names.", s.speechEngine === "system", () => act("chooseSpeech", "system")));
    if (s.whisperDownloadable) {
      speech.push(s.installStatus ? installProgress(s.installStatus)
        : row("Whisper", "More accurate with names and jargon. Downloads whisper-server, then about 490 MB.", button("Download…", () => act("installWhisper"))));
    }
    speech.push(row("Vocabulary", "Words to spell right: names, products, libraries.", button("Edit Vocabulary…", () => act("editVocabulary"))));
    return [
      card(null, null, [
        switchRow("Read answers aloud", "Answers are read out loud as well as shown.", s.speak, (on) => act("setSpeak", on)),
        row("Speed", null, segmented(String(s.speed), speeds, (v) => act("setSpeed", Number(v)))),
      ]),
      card("Voice", "Choosing a voice plays a sample.", [
        ...s.kokoroVoices.map((v) => voiceRow(v.id, `Kokoro · ${v.name}`)),
        voiceRow(null, s.platform === "win32" ? "Windows voice" : "System voice (speech-dispatcher)"),
        s.kokoroProblem && row("Kokoro isn't working", s.kokoroProblem + " The system voice reads answers until it's fixed.",
          button("Reinstall…", () => act("installKokoro")), { detailClass: "error" }),
        !s.kokoroInstalled && (s.installStatus ? installProgress(s.installStatus)
          : row("Natural voices", "Seven natural-sounding voices (US and UK) that run on your computer. About 350 MB.", button("Download…", () => act("installKokoro")))),
      ]),
      card("Speech recognition", null, speech),
      card("Audio devices", "These apply to VisionCLI only.", [
        row("Microphone", disconnected(s.inputDevice, s.inputs, "microphone"), devicePicker(true)),
        row("Speaker", disconnected(s.outputDevice, s.outputs, "speaker"), [devicePicker(false), button("Test", () => act("testSpeaker"))]),
      ]),
    ];
  },

  control: (s) => {
    const modes: { id: "ask" | "auto" | "off"; name: string; detail: string }[] = [
      { id: "ask", name: "Ask before each action", detail: "You approve every click and keystroke in a bubble." },
      { id: "auto", name: "Allow all actions", detail: "No approval needed, except for sensitive spots." },
      { id: "off", name: "Off", detail: "The assistant can look at your screen, but not click or type." },
    ];
    const INPUT_NAMES: Record<string, string> = { xtest: "X11 (XTest)", portal: "Remote Desktop portal", uinput: "Virtual keyboard and mouse (uinput)" };
    const windows = s.platform === "win32";
    // Windows needs no setup for any of these: keyboard hooks, UI Automation and SendInput are always available.
    const access = windows ? [
      row("Keyboard access", s.keyboardAccess ? `Notices when you hold ${s.shortcuts.holdName} (and ${s.shortcuts.added} for a screenshot).` : s.keyboardProblem ?? "VisionCLI's helper isn't running.",
        s.keyboardAccess ? allowed() : button("Try Again", () => act("grantKeyboardAccess"))),
      row("UI Automation", "Lets the assistant find buttons and fields in apps.", s.atspi ? allowed("On") : allowed("Built in")),
      row("Clicking and typing", "Through Windows input (SendInput).", allowed()),
    ] : null;
    return [
      card(null, "Passwords, payments and system settings always ask. Press Esc to stop it.",
        modes.map((m) => radioRow(m.name, m.detail, s.computerControl === m.id, () => act("setComputerControl", m.id)))),
      card(null, null, access ?? [
        row("Keyboard access (input group)",
          s.keyboardAccess
            ? (s.keyboardBackend === "xinput2" ? "Using the X11 fallback (XInput2). Join the input group to make it work on Wayland too." : `Notices when you hold ${s.shortcuts.holdName}, on X11 and Wayland.`)
            : s.keyboardProblem ?? `Needed to notice when you hold ${s.shortcuts.holdName}. Join the input group once, then log out and back in.`,
          s.keyboardAccess && s.keyboardBackend !== "xinput2" ? allowed() : s.keyboardAccess ? [allowed("X11 only"), button("Join Input Group…", () => act("grantKeyboardAccess"))]
            : button("Join Input Group…", () => act("grantKeyboardAccess"))),
        row("Accessibility (AT-SPI)", "Lets the assistant find buttons and fields in apps.",
          s.atspi ? allowed("On") : button("Turn On", () => act("enableAtspi"))),
        row("Clicking and typing", s.inputBackend ? `Through ${INPUT_NAMES[s.inputBackend] ?? s.inputBackend}.` : "Needed to click and type for you. On Wayland your desktop asks once to allow remote control.",
          s.inputBackend ? allowed() : button("Set Up…", () => act("setupInput"))),
      ]),
      card("Browser", null, [
        switchRow("Show AI cursor in browser", "An animated pointer shows where the assistant clicks and types.", s.ghostCursor, (on) => act("setGhostCursor", on)),
        switchRow("Instant browser commands (Jev)", "Simple browser commands run right away through Jev before asking the assistant. Needs a TypeSafe API key (Integrations).", s.quickCommands, (on) => act("setQuickCommands", on)),
      ]),
      card(null, null, [
        switchRow("Watch for app crashes", `Notices when an app crashes (${windows ? "Windows Error Reporting" : "systemd-coredump or Apport"}) and offers to explain why.`, s.watchCrashes, (on) => act("setWatchCrashes", on)),
      ]),
    ];
  },

  meetings: (s) => {
    const opt = (key: SettingsActions["setMeetingOption"]["key"]) => (on: boolean) => act("setMeetingOption", { key, on });
    return [
      card(null, null, [
        switchRow("Meeting Notes", `Listens to your computer's sound (your colleagues) and your microphone (you), transcribes both on this computer and shows the conversation in a panel. Start it anywhere with ${s.meetingShortcut}. Off each time VisionCLI starts.`,
          s.meetingNotes, (on) => { if (on !== s.meetingNotes) void act("toggleMeeting"); else render(); }),
        s.meetingNotes && row("Listening now", "The panel shows the conversation, summaries and replies.", button("Show Panel", () => act("showMeetingPanel"))),
      ]),
      card("During a meeting", "Summaries, replies and code answers use Claude under your own account: the transcript text is sent, never the audio.", [
        switchRow("Summarize what colleagues say", "A one-line summary under each of their turns (Claude Haiku).", s.meetingSummarizeGuest, opt("meetingSummarizeGuest")),
        switchRow("Summarize what you say", "A summary under your own turns too. Your words are always in the notes and the meeting summary.", s.meetingSummarizeYou, opt("meetingSummarizeYou")),
        switchRow("Suggest replies", "When a colleague asks you something, three short replies appear once they've finished talking. Click to copy; nothing is sent.", s.meetingReplies, opt("meetingReplies")),
        switchRow("Answer code questions from the project", "Questions like \"which endpoint handles refunds?\" are looked up in the project's code (read-only) and answered with file:line.", s.meetingCodeLookup, opt("meetingCodeLookup")),
        switchRow("Record the meeting", "Keeps a recording of both sides on this computer, to play back with the transcript.", s.meetingRecord, opt("meetingRecord")),
      ]),
      card("Past meetings", "Each meeting is saved with its notes, the summary and the recording, in VisionCLI's meetings folder.", [
        !s.pastMeetings.length && h("p.note", { style: { padding: "8px 0" } }, "None yet."),
        ...s.pastMeetings.map((m) => row(m.name, null, button("Open", () => act("openMeeting", m.id), { disabled: s.meetingNotes }))),
        row("All meetings", null, button("Show in Folder", () => act("openMeetings"))),
      ]),
      card("Privacy", null, [
        switchRow("Hide VisionCLI from screen sharing and recordings",
          s.canHideFromCapture ? "The Meeting Notes panel, bubble, badge, Visi and VisionCLI's windows are left out when you share or record your screen. Some capture apps may still show them." : "Not supported on Linux.",
          s.canHideFromCapture && s.hideFromCapture, (on) => act("setHideFromCapture", on), !s.canHideFromCapture),
      ]),
    ];
  },

  integrations: (s) => {
    const integration = (a: AssistantId, install: string) => {
      const installed = s.installed[a];
      const t = s.tools[a];
      const detail = installed ? t.error ?? (t.connected === null && !t.connecting ? "Checking…" : null) : install;
      let control: Child;
      if (!installed) control = h("span.muted", null, "Not installed");
      else if (t.connecting) control = [spinner(), h("span.muted", null, "Connecting…")];
      else if (t.connected) control = [allowed("Tools connected"), button("Reconnect", () => act("connectTools", a), { title: "Register the tools again, e.g. after moving the app or switching Node versions" })];
      else if (t.connected === false || t.error) control = button(t.error ? "Try Again" : "Connect", () => act("connectTools", a));
      return row(APP_NAMES[a] === "Gemini CLI" ? "Gemini CLI" : APP_NAMES[a], detail, control ?? null, { detailClass: t.error ? "error" : undefined });
    };
    return [
      card(null, "Connecting adds VisionCLI's tools to that CLI for every project. Restart running sessions to load them.", [
        integration("claude", "Install from claude.com/claude-code, then run claude once to sign in."),
        integration("antigravity", "Install Antigravity from antigravity.google, then run agy once to sign in."),
        // Gemini answers through Antigravity; the separate Gemini CLI only shows when it's installed.
        ...(s.installed.gemini ? [integration("gemini", "")] : []),
      ]),
      card("Add-ons for Claude Code", s.installed.claude ? "Installed for all your projects. Restart running Claude sessions to load them." : "Install Claude Code first (claude.com/claude-code).",
        s.addOns.map((a) => row(a.title, a.error ? `${a.detail} ${a.error}` : a.detail,
          a.installed ? allowed("Installed") : a.installing ? spinner() : button("Install", () => act("installAddOns", [a.id]), { disabled: !s.installed.claude })))),
      card(null, null, [
        row("API keys", "TypeSafe (for Jev instant browser commands) and an optional Gemini API key, kept in integrations.json.", button("Edit API Keys…", () => act("openIntegrations"))),
      ]),
    ];
  },

  usage: () => {
    const u = usage;
    const cell = (text: string | null, bold: boolean) =>
      h("span", { style: { width: "90px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: bold ? "600" : "", color: bold ? "" : "var(--secondary)" } }, text ?? "");
    const line = (name: string, cells: Child[]) => {
      const bold = name === "Total";
      return h("div.row", null, h("div.row-text", null, h("div.row-title", { style: { fontWeight: bold ? "600" : "" } }, name)), h("div.row-control", null, cells));
    };
    return [
      card("Running now", (u?.cpu === false ? "" : "CPU is a share of one core (100% = one full core). ") + "Updates every 2 seconds.",
        !u?.running.length ? [h("p.note", { style: { padding: "8px 0" } }, "Reading…")]
          : u.running.map((p) => line(p.name, [u.cpu && cell(p.cpu, p.name === "Total"), cell(p.memory, p.name === "Total")]))),
      u?.disk.length ? card("On disk", null, u.disk.map((d) => line(d.name, [cell(d.size, !d.path),
        d.path ? h("button.icon-button", { title: "Show in Folder", onclick: () => window.vcli.invoke("settings:showResource", d.path) }, icon("search", 15))
          : h("span", { style: { width: "26px" } })]))) : null,
    ];
  },

  advanced: (s) => [
    card(null, null, [
      row("Desktop", s.desktopProblem ?? "Everything VisionCLI needs from your desktop is available.", h("span.muted", null, s.desktop), { detailClass: s.desktopProblem ? "error" : undefined }),
      row("Reset permissions", "If screen capture or clicking stopped working: forgets the saved screen-sharing and remote-control consent so your desktop asks again.",
        button("Reset Permissions…", () => act("fixPermissions"))),
    ]),
    backupCard(s),
    card("Files", null, [
      row("Log", "What VisionCLI did, for troubleshooting.", button("Open Log", () => act("openLog"))),
      s.crashLogExists && row("Crash log", "Details of the last crash.", button("Open Crash Log", () => act("openCrashLog"))),
      row("Home folder", `${s.homeProject.replace(/^\/home\/[^/]+|^\/root/, "~")}, where general questions (no project) run.`, button("Show in Files", () => act("openHome"))),
    ]),
    h("div.footnote", null, `VisionCLI ${s.version} · MIT License · github.com/thethirdsourcers/visioncli`),
  ],
};

function modelRow(s: SettingsSnapshot): HTMLElement {
  if (s.assistant === "antigravity") {
    const opts: Option[] = [{ value: "", label: "Default (from your agy settings)" }, ...s.agyModels.map((m, i) => ({ value: m.id, label: m.name, divider: i === 0 }))];
    // A saved model agy no longer lists still shows as the current choice.
    if (s.agyModel && !s.agyModels.some((m) => m.id === s.agyModel)) opts.push({ value: s.agyModel, label: s.agyModel });
    return row("Model", s.agyModels.length ? "Gemini models available to your agy sign-in." : "Loading models from agy…", select(s.agyModel ?? "", opts, (v) => act("setAgyModel", v || null)));
  }
  if (s.fixedModel) {
    const label = s.claudeModels.find((m) => m.id === s.fixedModel)?.name.split(" (")[0] ?? s.fixedModel;
    return row("Model", "Set by VISIONCLI_MODEL (or --model) when VisionCLI was started; change it there.", h("span.muted", null, label));
  }
  const opts: Option[] = s.claudeModels.map((m) => ({ value: m.id, label: m.name, divider: m.id === "opusplan" }));
  if (!s.claudeModels.some((m) => m.id === s.claudeModel)) opts.push({ value: s.claudeModel, label: s.claudeModel });
  return row("Model", "A running terminal Claude switches too.", select(s.claudeModel, opts, (v) => act("setClaudeModel", v)));
}

const keysOf = (s: SettingsSnapshot, id: string) => s.shortcuts.list.find((x) => x.id === id)?.keys ?? "";

/** The shortcut being recorded (its button says "Press keys…"); the next key press with a modifier replaces it. */
let recording: string | null = null;

/** Settings → General → Shortcuts (ShortcutsCard): the hold-to-talk key, and each key combination re-recorded or reset. */
function shortcutsCard(s: SettingsSnapshot): HTMLElement {
  const k = s.shortcuts;
  const sup = s.platform === "win32" ? "Win" : "Super";
  const holdKeys: Option[] = [{ value: "alt", label: "Alt" }, { value: "ctrl", label: "Ctrl" }, { value: "super", label: sup }];
  return card("Shortcuts", !recording && k.note ? k.note : `Click a shortcut, then press the new keys (with Ctrl, Alt or ${sup}). Esc cancels.`, [
    row("Hold to talk", `Hold it, ask, let go. Add ${k.added} for a screenshot (${k.screenKeys}).`, select(k.hold, holdKeys, (v) => act("setHoldKey", v as SettingsActions["setHoldKey"]))),
    ...k.list.map((x) => row(x.title, null, [
      button(recording === x.id ? "Press keys…" : x.keys, () => { recording = x.id; render(); }),
      h("button.icon-button", { title: "Back to the default", disabled: !x.custom, onclick: () => { recording = null; void act("resetShortcut", x.id); } }, icon("undo", 15)),
    ])),
  ]);
}

document.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"].includes(e.key)) return; // wait for the key itself
  const id = recording;
  recording = null;
  render();
  if (e.key !== "Escape") void act("recordShortcut", { id, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
}, true);

let backupPassword = "";

/** Claude backup: where backups go, and back up / restore by hand (ClaudeBackupCard). */
function backupCard(s: SettingsSnapshot): HTMLElement {
  const b = s.backup;
  const home = s.homeProject.replace(/[\\/]VisionCLI$/, "");
  const where = b.folder && (b.folder.startsWith(home) ? "~" + b.folder.slice(home.length) : b.folder);
  const buttons = (...list: Child[]) => h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", padding: "8px 0" } }, list);
  const rows: Child[] = [
    h("div.row", null,
      h("div.row-text", null,
        h("div.row-title", null, "Back up ~/.claude daily"),
        h("div.row-detail", null, where ? `To ${where}` : "Everything Claude Code knows (CLAUDE.md, settings, skills, memory, plugins, conversations), encrypted, into a folder you pick such as one synced by Google Drive. After the first backup, only what changed is added."),
        b.status && h("div.row-detail", null, b.status),
        b.fraction != null && h("div", { style: { maxWidth: "260px", paddingTop: "2px" } }, progress(b.fraction))),
      h("div.row-control", null, b.running && spinner(), button(b.folder ? "Change…" : "Choose Folder…", () => act("backupChooseFolder"), { disabled: b.running }))),
  ];
  if (b.askPassword) {
    const submit = () => { const pw = backupPassword; backupPassword = ""; void act("backupPassword", pw); };
    rows.push(buttons(
      h("input", { type: "password", placeholder: "Backup password", "data-key": "backup-password", value: backupPassword, style: { flex: "1", minWidth: "160px" },
        oninput: (e: Event) => { backupPassword = (e.target as HTMLInputElement).value; },
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") submit(); } }),
      button("Use Backups", submit, { primary: true }),
      button("Cancel", () => { backupPassword = ""; void act("backupCancel"); })));
  } else if (b.snapshots) {
    const pick = select(b.snapshots[0]?.id ?? "", b.snapshots.map((x) => ({ value: x.id, label: x.name })), () => {});
    rows.push(h("div", null,
      h("p.row-detail", { style: { padding: "8px 0 0" } }, "Quit Claude Code first. Your current ~/.claude and ~/.claude.json are moved to ~/.claude-before-restore-… (not deleted), then the backup is put in their place."),
      buttons(pick, button("Restore", () => act("backupRestoreSnapshot", pick.value), { primary: true }), button("Cancel", () => act("backupCancel")))));
  } else if (b.folder) {
    rows.push(buttons(
      button("Back Up Now", () => act("backupNow"), { disabled: b.running }),
      button("Restore…", () => act("backupRestore"), { disabled: b.running }),
      button("Show Backups", () => act("backupShow")),
      h("span.grow", { style: { flex: "1" } }),
      button("Copy Password", () => act("backupCopyPassword")),
      button("Turn Off", () => act("backupOff"), { disabled: b.running })));
  }
  return card("Claude backup", null, rows);
}

function parakeetProgress(s: SettingsSnapshot): HTMLElement {
  const p = s.parakeetProgress;
  if (p === null) return h("div.install", null, h("div.row-detail", { style: { display: "flex", gap: "6px", alignItems: "center" } }, spinner(), "Loading Parakeet…"));
  return h("div.install", null, progress(p), h("div.row-detail", null, p < 0.98 ? `Downloading Parakeet… ${Math.round(p * 100)}%` : "Preparing the model…"));
}

let usage: ResourceUsageView | null = null;

async function refreshUsage() {
  if (section !== "usage") return;
  usage = await window.vcli.invoke("settings:usage");
  render();
}

// ── Wiring ──

window.vcli.on("settings:snapshot", (next: SettingsSnapshot) => show(next));
window.vcli.on("settings:section", (id: SettingsSection) => { if (SECTIONS.some((x) => x.id === id)) { section = id; render(true); void refreshUsage(); } });
// Things change behind the window's back: downloads progress, devices come and go, access gets granted.
poll(async () => show(await window.vcli.invoke("settings:get")), 1500);
poll(refreshUsage, 2000); // Settings → Usage, only while it's the page shown
void (async () => {
  show(await window.vcli.invoke("settings:get"), true);
  void act("checkTools");
})();
