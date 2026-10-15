import { basename } from "node:path";
import type { MenuId, MenuModel } from "./types";

// The tray menu as plain data (App+Menu.swift menuNeedsUpdate), so it's testable without Electron; tray.ts turns it
// into an Electron Menu. Wording follows macOS; only "menu bar" becomes "tray icon" (StatusNotifier shows no text).

export type LocalId = "history" | "settings";

export interface MItem {
  id?: MenuId | LocalId;
  arg?: string | null;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  checked?: boolean;
  enabled?: boolean;
  /** A usage ring (percent) or a warning sign drawn by icons.ts. */
  icon?: { ring: number } | "warning" | "gauge";
  submenu?: MItem[];
}

const sep: MItem = { type: "separator" };

/** ProjectSelector.label: "Home" for VisionCLI Home, else the folder name. */
export function projectLabel(project: string, home: string): string {
  return project === home ? "Home" : basename(project) || project;
}

/** The project name shown with the icon (the tooltip on Linux): at most 18 characters. */
export function shortName(name: string): string {
  return name.length > 18 ? name.slice(0, 17) + "…" : name;
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.floor(n / 1_000)}K` : `${n}`;
}

/** "3:05 PM" today, "Tue 3:05 PM" otherwise (UsageTracker.resets). */
export function resets(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** "5 minutes ago" (RelativeDateTimeFormatter). */
export function relative(iso: string, now = new Date()): string {
  const s = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const f = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 60) return f.format(s, "second");
  if (a < 3600) return f.format(Math.round(s / 60), "minute");
  if (a < 86400) return f.format(Math.round(s / 3600), "hour");
  return f.format(Math.round(s / 86400), "day");
}

export function tooltip(m: MenuModel): string {
  const name = shortName(projectLabel(m.currentProject, m.homeProject));
  const { session, week } = m.usage;
  if (m.usage.inMenuBar && session && week) {
    return `VisionCLI · ${name}\n${m.usage.name ?? "Claude"} usage: ${session.percent}% of this 5-hour session, ${week.percent}% of this week`;
  }
  return `VisionCLI · ${name}`;
}

/** Rings drawn on the tray icon: the session, plus the week when turned on (UsageArt.barTitle). */
export function trayRings(m: MenuModel): { session: number; week: number | null } | null {
  const { session, week, inMenuBar, weeklyInMenuBar } = m.usage;
  if (!inMenuBar || !session || !week) return null;
  return { session: session.percent, week: weeklyInMenuBar ? week.percent : null };
}

export function buildMenu(m: MenuModel, now = new Date()): MItem[] {
  const items: MItem[] = [];
  const pinned = m.pinnedProject;

  // Project, picked by hand: Home, then candidates (running CLIs, open editor windows, recents), Choose Folder…
  const projects: MItem[] = [
    { id: "pickProject", arg: m.homeProject, label: "Home: general questions, no project", type: "checkbox", checked: pinned === m.homeProject },
    sep,
  ];
  const seen = new Set([m.homeProject]);
  const home = process.env.HOME ?? "";
  let added = 0;
  const add = (path: string, note: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    added++;
    const short = home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
    projects.push({ id: "pickProject", arg: path, label: `${basename(path)}   ${note}${short}`, type: "checkbox", checked: pinned === path });
  };
  for (const r of m.running) add(r.project, `${r.assistant} running · `);
  for (const p of m.windows) add(p, "open · ");
  for (const p of m.recent) add(p, "recent · ");
  if (!added) projects.push({ label: "No projects found yet", enabled: false });
  projects.push(sep, { id: "chooseFolder", label: "Choose Folder…" });
  items.push({ label: `Project: ${projectLabel(m.currentProject, m.homeProject)}`, submenu: projects });

  items.push(usageItem(m, now));
  if (m.updateStatus) items.push({ label: m.updateStatus, enabled: false });
  else if (m.updateAvailable) items.push({ id: "installUpdate", label: `Install Update (${m.updateAvailable})…` });
  if (m.screenProblem) items.push({ id: "setupScreen", label: m.screenProblem });
  items.push(sep);

  // No key equivalents (⌘Y, ⌘N…): they only work while a macOS menu is open, and a StatusNotifier menu can't take them.
  items.push(
    { id: "history", label: "History…" },
    { id: "newConversation", label: "New Conversation" },
    { id: "copyLastAnswer", label: "Copy Last Answer" },
  );
  // Actions, not settings, so they stay in the menu (where answers appear is chosen in Settings → Assistant).
  if (m.terminalMode) {
    items.push({ id: "showTerminal", label: `Show ${m.assistantName} Terminal` });
  } else {
    items.push(
      { id: "showActivity", label: "Show Live Activity in Terminal" },
      { id: "continueInTerminal", label: "Continue Conversation in Terminal", enabled: m.canContinueInTerminal },
    );
  }
  items.push(sep, { id: "settings", label: "Settings…" }, { id: "quit", label: "Quit VisionCLI" });
  return items;
}

/** Plan usage (Claude, or Gemini through Antigravity) with its card (UsageCard) as plain rows: Electron menus can't
 *  host custom views. */
function usageItem(m: MenuModel, now: Date): MItem {
  const { session, week, today, updated } = m.usage;
  const who = m.usage.name ?? "Claude";
  const card: MItem[] = [];
  const meter = (title: string, w: { percent: number; resetsAt: string }) => {
    card.push({ label: `${title}   ${w.percent}%`, enabled: false, icon: { ring: w.percent } });
    card.push({ label: `      Resets ${resets(w.resetsAt, now)}`, enabled: false });
  };
  if (session) meter("Session (5 hours)", session);
  if (week) meter("This week", week);
  if (!session && !week) card.push({ label: "No usage yet: ask something or Refresh", enabled: false, icon: "gauge" });
  card.push(sep);
  if (who === "Claude") {
    card.push({ label: `Today   ${today.requests} requests`, enabled: false });
    card.push({ label: `      ↑ ${tokens(today.input)} in   ↓ ${tokens(today.output)} out   ${tokens(today.cached)} cached`, enabled: false });
    card.push({ label: `      All Claude Code sessions on this computer${updated ? " · limits " + relative(updated, now) : ""}`, enabled: false });
  } else {
    // The other model groups' limits (e.g. Claude and GPT models used through Antigravity).
    for (const g of (m.usage.groups ?? []).slice(1)) {
      card.push({ label: g.name, enabled: false });
      if (g.session) card.push({ label: `      5 hours ${g.session.percent}% · resets ${resets(g.session.resetsAt, now)}`, enabled: false, icon: { ring: g.session.percent } });
      if (g.week) card.push({ label: `      Week ${g.week.percent}% · resets ${resets(g.week.resetsAt, now)}`, enabled: false, icon: { ring: g.week.percent } });
    }
    card.push({ label: `Antigravity plan${updated ? " · " + relative(updated, now) : ""}`, enabled: false });
  }
  card.push(sep);
  card.push({ id: "refreshUsage", label: "Refresh Usage" });
  card.push({ id: "toggleUsageInMenuBar", label: "Show Session on Tray Icon", type: "checkbox", checked: m.usage.inMenuBar });
  card.push({ id: "toggleWeeklyInMenuBar", label: "Show Weekly on Tray Icon", type: "checkbox", checked: m.usage.weeklyInMenuBar, enabled: m.usage.inMenuBar });
  const both = session && week;
  return {
    label: both ? `${who} Usage: ${session.percent}% session · ${week.percent}% week` : `${who} Usage`,
    icon: Math.max(session?.percent ?? 0, week?.percent ?? 0) >= 80 ? "warning" : "gauge",
    submenu: card,
  };
}
