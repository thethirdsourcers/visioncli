import { statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KOKORO_FILES } from "../features/installer";
import { log } from "../log";
import { TMP } from "../paths";
import { settings } from "../settings";
import { find, probeTerminals } from "../terminal/probe";
import { cliFor } from "../terminal/transcripts";
import { App } from "./core";
import { makeShot, windowLabel, windowUnderPointer } from "./shots";

// Debug launch flags (App+Debug.swift): `visioncli --flag` exercises one path of the app without the hotkey.

declare module "./core" {
  interface App {
    runDebugFlags(argv: string[]): void;
  }
}

const after = (s: number, fn: () => void) => setTimeout(fn, s * 1000);

App.prototype.runDebugFlags = function (this: App, argv: string[]) {
  const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };

  // `--say "text"` speaks text on launch (the voice output path).
  const say = arg("--say");
  if (say != null) after(4, () => this.speaker.feed(say, true, true));

  // `--meeting-test [seconds]` starts Meeting Notes without the consent dialog (and stops it after `seconds`);
  // `--meeting-launcher` shows the shortcut's card.
  if (argv.includes("--meeting-test")) {
    after(3, () => {
      this.meetingConsented = true;
      void this.startMeeting(settings.get("pinnedProject") ?? this.currentProject);
      const s = Number(arg("--meeting-test"));
      if (s > 0) after(3 + s, () => { if (this.meeting.isOn) void this.toggleMeeting(); });
    });
  }
  if (argv.includes("--meeting-launcher")) after(3, () => this.showMeetingLauncher());

  // `--listen-test` records 2 s, three times in a row (the audio path without the hotkey).
  if (argv.includes("--listen-test")) {
    const round = (n: number) => {
      if (n <= 0) return;
      after(1, async () => {
        const wav = join(TMP, `visioncli-listen-test-${n}.wav`);
        try {
          await this.recorder.start(wav, settings.get("inputDevice"));
          log("listen-test: started");
          await new Promise((r) => setTimeout(r, 2000));
          const rec = await this.recorder.stop();
          const text = this.engine ? await this.engine.transcribe(rec.file, [], false) : "";
          log(`listen-test: stopped, wav ${statSync(rec.file).size} bytes, heard "${text}"`);
        } catch (e) { log(`listen-test: ${(e as Error)?.message ?? e}`); }
        rmSync(wav, { force: true });
        round(n - 1);
      });
    };
    round(3);
  }

  // `--probe-terminal` logs which CLIs run in terminals and how VisionCLI would type into them.
  if (argv.includes("--probe-terminal")) {
    void (async () => {
      const started = Date.now();
      const c = await find(cliFor(settings.get("assistant")), this.cfg.cwd);
      log(`find ${settings.get("assistant")} for ${this.cfg.cwd}: ${c ? `${c.delivery.kind} session=${c.sessionId ?? "-"} cwd=${c.cwd}` : "none"} (${Date.now() - started}ms)`);
      for (const t of await probeTerminals()) log(`probe: ${t.assistant} pid ${t.pid} cwd=${t.cwd} delivery=${JSON.stringify(t.delivery)}`);
    })();
  }

  // `--test-download` fetches the small Kokoro voices file through the installer (progress, save, finish).
  if (argv.includes("--test-download")) {
    after(3, () => {
      this.installer.onFinished = (kind, error) => log(`test-download finished: ${kind} error=${error ?? "none"}`);
      void this.installer.debugDownload([KOKORO_FILES[1]]);
      const t = setInterval(() => { if (this.installer.status) log(`test-download status: ${this.installer.status}`); else clearInterval(t); }, 2000);
    });
  }

  // `--demo-answer` shows a sample answer with a mermaid diagram and screen drawings (rendering check).
  if (argv.includes("--demo-answer")) {
    after(4, async () => {
      try {
        const [wins, p] = await Promise.all([this.desktop.windows().catch(() => []), this.pointer()]);
        const w = windowUnderPointer(wins, p);
        if (w) {
          this.currentShots = [makeShot(await this.ui.hiddenDuring(() => this.desktop.captureWindow(w)), w.bounds, windowLabel(w), p, w)];
        } else {
          const d = (await this.desktop.displays())[0];
          if (d) this.currentShots = [makeShot(await this.ui.hiddenDuring(() => this.desktop.captureRect(d)), d, "Screen", p)];
        }
      } catch (e) { log(`demo: capture failed: ${(e as Error)?.message ?? e}`); }
      const shot = this.currentShots[0];
      log(`demo: ${shot?.label ?? "no screenshot"}`);
      const W = Math.trunc(shot?.pixelSize.width ?? 1200), H = Math.trunc(shot?.pixelSize.height ?? 800);
      const t = Math.trunc;
      this.state.question = "How are orders and payments related?";
      this.state.project = "demo";
      this.state.raw = [
        "Each order can have several payments; a payment always points back to one order through `order_id`.",
        "```mermaid",
        "erDiagram",
        "  ORDERS ||--o{ PAYMENTS : \"paid by\"",
        "  ORDERS { int id  decimal total }",
        "  PAYMENTS { int id  int order_id  decimal amount }",
        "```",
        `Start at the order [[step:1:${t(W / 6)},${t(H / 5)}:1:Order]], follow it [[arrow:1:${t(W / 6)},${t(H / 5) + 30},${t(W / 6)},${t(H * 3 / 4) - 40}:order_id]] to the payment [[circle:1:${t(W / 12)},${t(H * 3 / 4) - 30},${t(W / 4) + 40},${t(H * 3 / 4) + 40}:Payment]] [[step:1:${t(W / 4) + 70},${t(H * 3 / 4)}:2:Refunds too]] [[box:1:${t(W * 3 / 5)},${t(H / 10)},${t(W * 9 / 10)},${t(H / 10) + 70}:Totals]].`,
      ].join("\n");
      this.set("thinking");
      this.finish(this.state.raw, null);
      this.state.pinned = false;
    });
  }

  // `--test-update` checks GitHub and installs a newer release without dialogs.
  if (argv.includes("--test-update")) {
    after(3, async () => {
      const release = await this.updater.check(true);
      log(`test-update: running ${this.version}, latest newer release: ${release?.version ?? "none"}`);
      if (release) await this.updater.install();
    });
  }

  // `--ask "question"` runs a question through the normal pipeline (no voice), to test assistants end to end.
  const ask = arg("--ask");
  if (ask != null) {
    after(5, () => {
      log(`debug ask (${settings.get("assistant")}, ${settings.get("terminalMode") ? "terminal" : "bubble"}): ${ask}`);
      this.state.question = ask;
      this.withScreen = false;
      this.set("thinking");
      if (!settings.get("terminalMode")) {
        this.sessions.warm(this.currentProject, "strong");
        if (this.routingOn) this.sessions.warm(this.currentProject, "fast");
      }
      void this.questionReady(ask);
    });
  }
};
