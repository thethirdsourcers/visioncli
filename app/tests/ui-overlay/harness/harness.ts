// Visual check of the overlay windows on a real X server (run by docker.sh under Xvfb + openbox + a compositor):
// renders every state, screenshots the whole screen after each with `import -window root` into $SHOTS.
import { app } from "electron";
import { execFileSync } from "node:child_process";
import type { OverlayState } from "../../../src/main/contracts";
import { createOverlayUI } from "../../../src/main/ui/overlay";

app.commandLine.appendSwitch("enable-transparent-visuals");
app.commandLine.appendSwitch("disable-gpu");
const SHOTS = process.env.SHOTS ?? "/tmp";
const only = process.env.SCENES ? process.env.SCENES.split(",") : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, ...args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8" }); } catch (e: any) { return String(e.message); } };
// SHOT_CMD (e.g. "grim") captures a Wayland session; `import -window root` only sees X11/XWayland.
const shot = (name: string) => {
  const file = `${SHOTS}/${process.env.SHOT_PREFIX ?? ""}${name}.png`;
  if (process.env.SHOT_CMD) sh("bash", "-c", `${process.env.SHOT_CMD} ${file}`); else sh("import", "-window", "root", file);
  console.log("shot", name);
};
const move = (x: number, y: number) => sh("xdotool", "mousemove", String(x), String(y));

const base: OverlayState = { phase: "idle", question: "", live: "", level: 0, status: "", raw: "", pinned: false, speaking: false, screenshot: false, assistantName: "Claude" };

const ANSWER = `## Why the port is wrong
The server reads **PORT** before \`.env\` is loaded, so it falls back to \`3000\`. See \`src/server.ts:42\` and config.ts:7.

1. Load the env first
2. Then read the port

\`\`\`ts
import "dotenv/config";
const port = Number(process.env.PORT ?? 8080);
\`\`\`

\`\`\`mermaid
graph LR; A[index.ts] --> B[dotenv]; B --> C[server.ts]; C --> D((listen))
\`\`\`
That's it, [docs](https://nodejs.org/api/process.html#processenv) for more.`;

app.whenReady().then(async () => {
  const ui = createOverlayUI();
  ui.onAction((a) => console.log("action", JSON.stringify(a)));
  ui.hud.onAction((a) => console.log("hud", a));
  const scenes: [string, () => Promise<void>][] = [
    ["listening", async () => {
      move(620, 380);
      ui.mascot.state("listening", 0);
      for (let i = 0; i < 20; i++) {
        ui.render({ ...base, phase: "listening", live: "open the settings file and change the port to eight zero eight zero", level: 0.3 + 0.4 * Math.abs(Math.sin(i / 2)), screenshot: true });
        ui.mascot.state("listening", 0.05);
        await sleep(60);
      }
      await sleep(500);
    }],
    ["listening-moved", async () => { move(300, 600); await sleep(300); }],
    ["thinking", async () => {
      move(700, 300);
      ui.render({ ...base, phase: "thinking", status: "Reading src/server.ts…", project: "visioncli" });
      ui.mascot.state("thinking");
      await sleep(1200);
    }],
    ["answer", async () => {
      ui.mascot.state("hidden");
      ui.render({ ...base, phase: "done", question: "why does the server start on the wrong port?", raw: ANSWER, project: "visioncli", toast: "Copied" });
      await sleep(3500);
      console.log("pointerOverBubble", ui.pointerOverBubble());
    }],
    ["interact", async () => {
      // The answer takes the mouse: hover is reported, a file:line link and the close button send their actions.
      move(1300, 60); await sleep(400);
      console.log("pointerOverBubble", ui.pointerOverBubble());
      move(1121, 107); sh("xdotool", "click", "1"); await sleep(300);
      move(1396, 350); sh("xdotool", "click", "1"); await sleep(300);
      move(200, 800); await sleep(400);
      console.log("pointerOverBubble", ui.pointerOverBubble());
    }],
    ["answer-streaming", async () => {
      ui.render({ ...base, phase: "answering", question: "draw the request flow", raw: "Here's the flow so far:\n```mermaid\ngraph TD; A-->", project: "visioncli" });
      await sleep(1200);
    }],
    ["answer-pinned-speaking", async () => {
      ui.render({ ...base, phase: "done", question: "why does the server start on the wrong port?", raw: ANSWER + "\n\n" + "More detail. ".repeat(120), project: "visioncli", pinned: true, speaking: true });
      await sleep(2500);
    }],
    ["error", async () => {
      ui.render({ ...base, phase: "error", question: "", raw: "Claude isn't installed. Install it with `npm i -g @anthropic-ai/claude-code`." });
      await sleep(800);
    }],
    ["approval", async () => {
      ui.render({ ...base, phase: "approval", project: "visioncli", approval: {
        tool: "Edit src/server.ts", summary: "Claude wants to edit server.ts", queue: 1,
        preview: "- const port = Number(process.env.PORT ?? 3000);\n+ import \"dotenv/config\";\n+ const port = Number(process.env.PORT ?? 8080);\n  app.listen(port);" } });
      await sleep(1000);
    }],
    ["marks", async () => {
      ui.render({ ...base, phase: "idle" });
      ui.showMarks([
        { kind: "box", rect: { x: 700, y: 100, width: 400, height: 400 }, label: "The clock" },
        { kind: "circle", rect: { x: 60, y: 40, width: 240, height: 60 }, label: "Prompt" },
        { kind: "arrow", rect: { x: 500, y: 650, width: 250, height: -120 }, label: "Drag here" },
        { kind: "step", rect: { x: 480, y: 660, width: 0, height: 0 }, n: 1, label: "Start" },
        { kind: "step", rect: { x: 1200, y: 600, width: 0, height: 0 }, n: 2 },
      ], 25_000);
      await sleep(3500);
    }],
    ["region", async () => {
      ui.hideMarks();
      const p = ui.selectRegion();
      await sleep(1500);
      move(400, 250); sh("xdotool", "mousedown", "1"); await sleep(100);
      move(600, 400); await sleep(100); move(900, 560); await sleep(400);
      shot("region-dragging");
      sh("xdotool", "mouseup", "1");
      console.log("region", JSON.stringify(await p));
      const p2 = ui.selectRegion();
      await sleep(1200);
      shot("region-start");
      sh("xdotool", "key", "Escape");
      console.log("region-esc", JSON.stringify(await Promise.race([p2, sleep(1500).then(() => "timeout")])));
      ui.cancelRegion();
    }],
    ["spotlight", async () => {
      move(900, 300);
      ui.spotlight({ x: 700, y: 100, width: 400, height: 400 });
      await sleep(1000);
      ui.spotlight(null);
    }],
    ["glow", async () => {
      ui.controlGlow(true);
      await sleep(1500);
      ui.controlGlow(false);
      await sleep(600);
    }],
    ["spotlight-badge-glow", async () => {
      move(900, 300);
      ui.spotlight({ x: 700, y: 100, width: 400, height: 400 });
      ui.badge("Looking at xclock", { icon: "eye", seconds: 10 });
      ui.controlGlow(true);
      ui.render({ ...base, phase: "thinking", status: "Looking…", project: "visioncli" });
      await sleep(1500);
    }],
    ["hud", async () => {
      ui.spotlight(null);
      ui.render({ ...base, phase: "idle" });
      ui.badge("Using the computer", { icon: "cursorarrow.rays", tint: "#bf5af2", seconds: 10 });
      ui.hud.update([
        { id: "1", text: "Open Firefox", state: "done" },
        { id: "2", text: "Type “weather berlin” into the address bar", state: "done" },
        { id: "3", text: "Click the first result", state: "failed" },
        { id: "4", text: "Press Enter", state: "declined" },
        { id: "5", text: "Approve: send the message?", state: "waiting" },
        { id: "6", text: "Scroll to the forecast table and read the temperatures for the next three days", state: "running" },
      ], false, "Checking the weather");
      ui.render({ ...base, phase: "done", question: "what's the forecast?", raw: "Sunny, **24°C**." });
      await sleep(1500);
    }],
    ["hud-paused", async () => {
      ui.render({ ...base, phase: "idle" });
      ui.controlGlow(false);
      ui.hud.update([{ id: "1", text: "Open Firefox", state: "done" }], true);
      await sleep(900);
    }],
    ["stacking", async () => {
      // An app window raised and focused over the bubble: the bubble must stay above it.
      ui.render({ ...base, phase: "done", question: "stacking check", raw: "This bubble should stay **above** the terminal." });
      await sleep(600);
      sh("bash", "-c", "W=$(xdotool search --name bash | head -1); xdotool windowmove $W 800 20 windowactivate $W windowraise $W");
      await sleep(800);
      console.log(sh("bash", "-c", "for w in $(xdotool search --class electron); do xwininfo -id $w | grep -q IsViewable && echo \"$w $(xwininfo -id $w | grep -E 'Override|geometry' | tr -s ' ' | tr '\\n' ' ')\"; done; true"));
    }],
    ["mascot-peek", async () => {
      ui.hud.hide(); ui.badge(null);
      move(1200, 500);
      ui.mascot.state("peek", 0);
      await sleep(1200);
    }],
    ["mascot-talking", async () => {
      for (let i = 0; i < 10; i++) { ui.mascot.state("listening", 0.8); await sleep(50); }
    }],
    ["mascot-gone", async () => {
      ui.mascot.state("hidden");
      await sleep(1000);
    }],
  ];
  await sleep(800);
  for (const [name, run] of scenes) {
    if (only && !only.includes(name)) continue;
    await run();
    if (name !== "region") shot(name);
  }
  // Window list as the WM sees it (types, states) for the report.
  console.log(sh("bash", "-c", "for w in $(xdotool search --class electron 2>/dev/null); do xwininfo -id $w | grep -E 'Override' | tr -s ' '; done | sort | uniq -c"));
  ui.destroy();
  app.quit();
});
