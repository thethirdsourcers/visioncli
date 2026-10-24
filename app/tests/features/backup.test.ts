// Claude backup (ClaudeBackup.swift): restic's JSON, the status line, and a restore against a fake restic.
import "../assistant/_env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ClaudeBackup, formatBytes, newPassword, parseStatus, parseSummary, progressText, restoredPath, snapshotChoices, statusText,
} from "../../src/main/features/backup";
import { settings } from "../../src/main/settings";

test("backup: bytes, progress and the status line", () => {
  assert.equal(formatBytes(0), "Zero KB");
  assert.equal(formatBytes(512), "512 bytes");
  assert.equal(formatBytes(17_400), "17 KB");
  assert.equal(formatBytes(4_123_456_789), "4.1 GB");
  assert.deepEqual(parseStatus('{"message_type":"status","percent_done":0.42,"bytes_done":420,"total_bytes":1000}'), { pct: 0.42, done: 420, total: 1000 });
  assert.equal(parseStatus('{"message_type":"summary"}'), null);
  assert.equal(parseStatus("not json"), null);
  assert.equal(progressText("Backing up", 0.42, 2_000_000, 4_000_000), "Backing up… 42% (2 MB of 4 MB)");
  const out = '{"message_type":"status","percent_done":1}\n{"message_type":"summary","data_added":3000000,"data_added_packed":2100000,"total_files_processed":17837,"total_bytes_processed":4100000000}\n';
  const s = parseSummary(out);
  assert.deepEqual(s, { added: 2_100_000, whole: "4.1 GB, 17,837 files" });
  const now = Date.now();
  assert.equal(statusText(now, s.whole, s.added, now), "Last backup just now: all of ~/.claude (4.1 GB, 17,837 files), of which 2.1 MB was new. Keeps 7 daily and 4 weekly snapshots.");
  assert.equal(statusText(now - 3 * 3600_000, s.whole, 0, now), "Last backup 3 hours ago: all of ~/.claude (4.1 GB, 17,837 files), nothing changed since the last one. Keeps 7 daily and 4 weekly snapshots.");
  assert.equal(statusText(null, null, null), "No backup yet.");
});

test("backup: password, snapshots, restored paths", () => {
  const pw = newPassword();
  assert.match(pw, /^([a-zA-Z2-9]{6}-){3}[a-zA-Z2-9]{6}$/);
  assert.notEqual(pw, newPassword());
  const list = snapshotChoices(JSON.stringify([{ short_id: "aaa", time: "2026-10-01T10:00:00.123456789Z" }, { short_id: "bbb", time: "2026-10-02T10:00:00Z" }]));
  assert.deepEqual(list.map((x) => x.id), ["bbb", "aaa"], "newest first");
  assert.match(list[0].name, /2026.*·  bbb$/);
  assert.equal(restoredPath("/t", "/home/me", "linux"), "/t/home/me");
  assert.match(restoredPath("C:\\t", "C:\\Users\\me", "win32"), /t[\\/]C[\\/]Users[\\/]me$/);
});

// A fake restic: logs its arguments and password, and restores a marker file (or fails with FAKE_FAIL).
const fake = process.platform === "win32" ? null : (() => {
  const bin = mkdtempSync(join(tmpdir(), "fake-restic-"));
  writeFileSync(join(bin, "restic"), `#!/bin/sh
echo "$* | $RESTIC_PASSWORD" >> "${bin}/calls"
[ -n "$FAKE_FAIL" ] && { echo "Fatal: wrong password" >&2; exit 1; }
if [ "$1" = restore ]; then mkdir -p "$4$HOME/.claude"; echo restored > "$4$HOME/.claude/marker"; fi
exit 0
`, { mode: 0o755 });
  process.env.PATH = bin + delimiter + process.env.PATH;
  return bin;
})();

test("backup: restore swaps ~/.claude, keeps the old one aside, and leaves it alone on failure", { skip: !fake }, async () => {
  const home = mkdtempSync(join(tmpdir(), "backup-home-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "mine"), "current");
  writeFileSync(join(home, ".claude.json"), "{}");
  const b = new ClaudeBackup({ get: () => "s3cret-pw", set: () => {} }, home);
  settings.setStore("claudeBackupFolder", join(home, "drive"));

  b.snapshots = [{ id: "abc", name: "1 Oct · abc" }];
  process.env.FAKE_FAIL = "1";
  await b.restore("abc");
  delete process.env.FAKE_FAIL;
  assert.match(b.status, /^Restore failed: Fatal: wrong password/);
  assert.equal(readFileSync(join(home, ".claude", "mine"), "utf8"), "current", "untouched after a failure");

  b.snapshots = [{ id: "abc", name: "1 Oct · abc" }];
  await b.restore("abc");
  assert.equal(readFileSync(join(home, ".claude", "marker"), "utf8").trim(), "restored");
  const aside = readdirSync(home).find((n) => n.startsWith(".claude-before-restore-"))!;
  assert.equal(readFileSync(join(home, aside, ".claude", "mine"), "utf8"), "current", "the old files are kept aside");
  assert.ok(existsSync(join(home, aside, ".claude.json")));
  assert.ok(!readdirSync(home).some((n) => n.startsWith(".claude-restore-")), "staging folder removed");

  const calls = readFileSync(join(fake!, "calls"), "utf8");
  assert.ok(calls.includes("| s3cret-pw"), "password through RESTIC_PASSWORD");
  assert.ok(!calls.split("\n").some((l) => l.split(" | ")[0].includes("s3cret")), "never in the arguments");
  settings.setStore("claudeBackupFolder", undefined);
});
