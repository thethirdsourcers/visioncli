import { clipboard, dialog, safeStorage } from "electron";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeBackup, installHint, restic, type SecretStore } from "../features/backup";
import { log } from "../log";
import { SUP } from "../paths";
import type { SettingsActions, SettingsSnapshot } from "../ui/windows";
import { App } from "./core";

// Settings → Advanced → Claude backup (ClaudeBackupCard in ClaudeBackup.swift): where backups go, back up and restore
// by hand. The password is encrypted with Electron's safeStorage (the system keyring on Linux, DPAPI on Windows; the
// Keychain on macOS) and kept in a file only VisionCLI's user can read.

const KEY_FILE = join(SUP, "claude-backup.key");

export const backupSecret: SecretStore = {
  get() {
    try { return safeStorage.decryptString(readFileSync(KEY_FILE)); } catch { return null; }
  },
  set(value) {
    if (value === null) { rmSync(KEY_FILE, { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("this computer has no secret store for the password");
    writeFileSync(KEY_FILE, safeStorage.encryptString(value), { mode: 0o600 });
    try { chmodSync(KEY_FILE, 0o600); } catch {}
  },
};

declare module "./core" {
  interface App {
    backup: ClaudeBackup;
    startBackup(): void;
    backupSnapshot(): SettingsSnapshot["backup"];
    backupAction(name: string, value: unknown): Promise<void>;
  }
}

App.prototype.startBackup = function (this: App) {
  this.backup = new ClaudeBackup(backupSecret);
  this.backup.onChange = () => this.windows?.refreshWindows();
  this.backup.start();
};

App.prototype.backupSnapshot = function (this: App) {
  const b = this.backup, found = !!restic();
  return { restic: found, folder: b.folder, running: b.running, status: b.status || (found ? "" : installHint()), fraction: b.fraction, askPassword: !!b.pendingFolder, snapshots: b.snapshots };
};

App.prototype.backupAction = async function (this: App, name, value) {
  const b = this.backup;
  switch (name as keyof SettingsActions) {
    case "backupChooseFolder": {
      if (!restic()) { b.status = installHint(); b.onChange(); return; }
      const r = await dialog.showOpenDialog({
        title: "Pick a folder for Claude backups, e.g. one synced by Google Drive, Dropbox or OneDrive.",
        buttonLabel: "Back Up Here", defaultPath: b.folder ?? homedir(), properties: ["openDirectory", "createDirectory"],
      });
      if (r.canceled || !r.filePaths[0]) return;
      void b.useFolder(r.filePaths[0]).catch((e) => { log(`claude backup: ${e}`); b.refreshStatus(); });
      return;
    }
    case "backupPassword": void b.usePassword(String(value ?? "")); return;
    case "backupCancel": b.cancelPassword(); b.cancelRestore(); return;
    case "backupNow": void b.backUp(); return;
    case "backupRestore": void b.listSnapshots(); return;
    case "backupRestoreSnapshot": void b.restore(String(value)); return;
    case "backupShow": if (b.folder) this.openWithDefault(b.folder); return;
    case "backupCopyPassword": {
      const pw = backupSecret.get();
      if (!pw) return;
      clipboard.writeText(pw);
      b.status = "Password copied. Keep it in your password manager: without it the backups can't be opened.";
      b.onChange();
      return;
    }
    case "backupOff": if (!b.running) { b.folder = null; b.refreshStatus(); } return;
  }
};
