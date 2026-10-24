import AppKit
import Security
import SwiftUI

// Claude backup: everything Claude Code knows about you lives in ~/.claude (CLAUDE.md, settings, skills, memory,
// plugins, conversations) and ~/.claude.json (MCP servers, per-project settings). Once a day VisionCLI backs both up
// with restic into a folder you pick (one in Google Drive, iCloud Drive or Dropbox, or an external drive): the first
// backup is a full copy, later ones only add what changed, every snapshot restores in full, and it's all encrypted
// with a password kept in the Keychain. The login token (~/.claude/.credentials.json, Linux) is left out.

final class ClaudeBackup: ObservableObject {
    static let shared = ClaudeBackup()

    @Published private(set) var running = false
    @Published private(set) var status = ""
    @Published private(set) var fraction: Double?   // progress of the backup or restore running now

    private let queue = DispatchQueue(label: "dev.visioncli.claude-backup", qos: .utility)
    private var timer: Timer?
    private static let keychainService = "dev.visioncli.claude-backup"

    /// The folder picked for backups (the restic repository is a folder inside it); nil = backups off.
    var folder: String? {
        get { UserDefaults.standard.string(forKey: "claudeBackupFolder") }
        set { UserDefaults.standard.set(newValue, forKey: "claudeBackupFolder"); objectWillChange.send() }
    }

    private var lastBackup: Date? {
        get { UserDefaults.standard.object(forKey: "claudeBackupLast") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "claudeBackupLast") }
    }

    var repo: URL? { folder.map { URL(fileURLWithPath: $0).appendingPathComponent("visioncli-claude-backup") } }

    static var restic: String? {
        ["/opt/homebrew/bin/restic", "/usr/local/bin/restic", "/usr/bin/restic"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Checks hourly and backs up when the last one is a day old (so a Mac that sleeps overnight still gets one a day).
    func start() {
        refreshStatus()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.backUpIfDue() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in self?.backUpIfDue() }
    }

    private func backUpIfDue() {
        guard folder != nil, !running else { return }
        if let last = lastBackup, Date().timeIntervalSince(last) < 23 * 3600 { return }
        backUp()
    }

    // MARK: Password (Keychain)

    static var password: String? {
        get {
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: "restic", kSecReturnData as String: true]
            var out: CFTypeRef?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: "restic"]
            SecItemDelete(q as CFDictionary)
            guard let newValue else { return }
            var add = q
            add[kSecValueData as String] = Data(newValue.utf8)
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    private static func newPassword() -> String {
        let alphabet = Array("abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let chars = bytes.map { alphabet[Int($0) % alphabet.count] }
        return stride(from: 0, to: chars.count, by: 6).map { String(chars[$0..<min($0 + 6, chars.count)]) }.joined(separator: "-")
    }

    func copyPassword() {
        guard let pw = Self.password else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pw, forType: .string)
        status = "Password copied. Keep it in your password manager: without it the backups can't be opened."
    }

    // MARK: restic

    /// Runs restic on the repository with the password in its environment (never on the command line).
    private static func run(_ repo: URL, _ args: [String], password: String) -> (Int32, String, String) {
        guard let restic else { return (-1, "", "restic isn't installed (brew install restic)") }
        let env = ["HOME": home.path, "PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
                   "RESTIC_REPOSITORY": repo.path, "RESTIC_PASSWORD": password]
        return shell(restic, args, env: env)
    }

    /// Like `run`, but reads restic's --json output as it comes and reports its progress (on the main thread):
    /// "status" lines carry percent_done, bytes_done and total_bytes.
    private static func runWithProgress(_ repo: URL, _ args: [String], password: String, progress: @escaping (Double, Int64, Int64) -> Void) -> (Int32, String, String) {
        guard let restic else { return (-1, "", "restic isn't installed (brew install restic)") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: restic)
        p.arguments = args
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
                         "RESTIC_REPOSITORY": repo.path, "RESTIC_PASSWORD": password]
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        var stdout = Data(), stderr = Data(), pending = Data()
        let lock = NSLock()
        var lastReport = Date.distantPast
        out.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            guard !chunk.isEmpty else { return }
            lock.lock(); stdout.append(chunk); pending.append(chunk); lock.unlock()
            while let nl = pending.firstIndex(of: 10) {
                let line = pending[pending.startIndex..<nl]
                pending.removeSubrange(pending.startIndex...nl)
                guard Date().timeIntervalSince(lastReport) > 0.25,
                      let o = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                      o["message_type"] as? String == "status", let pct = o["percent_done"] as? Double else { continue }
                lastReport = Date()
                let done = (o["bytes_done"] as? NSNumber)?.int64Value ?? 0, total = (o["total_bytes"] as? NSNumber)?.int64Value ?? 0
                DispatchQueue.main.async { progress(pct, done, total) }
            }
        }
        err.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            lock.lock(); stderr.append(chunk); lock.unlock()
        }
        do { try p.run() } catch { return (-1, "", error.localizedDescription) }
        p.waitUntilExit()
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        stdout.append(out.fileHandleForReading.readDataToEndOfFile())
        stderr.append(err.fileHandleForReading.readDataToEndOfFile())
        lock.lock(); defer { lock.unlock() }
        return (p.terminationStatus, String(decoding: stdout, as: UTF8.self), String(decoding: stderr, as: UTF8.self))
    }

    private static func progressText(_ verb: String, _ pct: Double, _ done: Int64, _ total: Int64) -> String {
        let f = { (n: Int64) in ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }
        return "\(verb)… \(Int(pct * 100))%" + (total > 0 ? " (\(f(done)) of \(f(total)))" : "")
    }

    private static func failure(_ r: (Int32, String, String)) -> String {
        let e = r.2.trimmingCharacters(in: .whitespacesAndNewlines)
        return e.isEmpty ? "restic failed (\(r.0))" : String(e.split(separator: "\n").last ?? Substring(e))
    }

    func chooseFolder() {
        guard Self.restic != nil else {
            status = "Install restic first: brew install restic"
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Back Up Here"
        panel.message = "Pick a folder for Claude backups, e.g. one in Google Drive or iCloud Drive."
        let cloud = home.appendingPathComponent("Library/CloudStorage")
        panel.directoryURL = FileManager.default.fileExists(atPath: cloud.path) ? cloud : home
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let repo = url.appendingPathComponent("visioncli-claude-backup")
        // A folder with backups from before (another Mac, or a reinstall): its password is needed to use it.
        var pw = Self.password
        let existing = FileManager.default.fileExists(atPath: repo.appendingPathComponent("config").path)
        if existing, pw == nil || Self.run(repo, ["cat", "config"], password: pw!).0 != 0 {
            guard let typed = askPassword(for: repo) else { return }
            guard Self.run(repo, ["cat", "config"], password: typed).0 == 0 else {
                status = "That password doesn't open the backups in this folder."
                return
            }
            pw = typed
        }
        let password = pw ?? Self.newPassword()
        running = true
        status = existing ? "Using the backups in this folder…" : "Setting up…"
        queue.async { [weak self] in
            var error: String?
            if !existing {
                let r = Self.run(repo, ["init"], password: password)
                if r.0 != 0 { error = Self.failure(r) }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = false
                self.fraction = nil
                if let error { self.status = "Couldn't set up backups: \(error)"; return }
                Self.password = password
                self.folder = url.path
                log("claude backup: repository \(repo.path)\(existing ? " (existing)" : "")")
                self.backUp()
            }
        }
    }

    private func askPassword(for repo: URL) -> String? {
        let alert = NSAlert()
        alert.messageText = "This folder already has Claude backups"
        alert.informativeText = "Enter the backup password to use them (Settings → Advanced → Claude backup → Copy Password, on the computer that made them)."
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        alert.accessoryView = field
        alert.addButton(withTitle: "Use Backups")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn, !field.stringValue.isEmpty else { return nil }
        return field.stringValue
    }

    func backUp() {
        guard let repo, let password = Self.password, !running else { return }
        running = true
        status = "Backing up…"
        queue.async { [weak self] in
            var paths = [home.appendingPathComponent(".claude").path]
            let json = home.appendingPathComponent(".claude.json").path
            if FileManager.default.fileExists(atPath: json) { paths.append(json) }
            let r = Self.runWithProgress(repo, ["backup", "--json", "--tag", "visioncli", "--exclude", home.appendingPathComponent(".claude/.credentials.json").path] + paths, password: password) { [weak self] pct, done, total in
                guard let self, self.running else { return }
                self.fraction = pct
                self.status = Self.progressText("Backing up", pct, done, total)
            }
            if r.0 == 0 || r.0 == 3 { DispatchQueue.main.async { [weak self] in self?.status = "Cleaning up old snapshots…" } }
            // 3 = some files couldn't be read (a conversation being written): the snapshot is still made.
            let ok = r.0 == 0 || r.0 == 3
            var added = "", whole = ""
            if ok, let line = r.1.split(separator: "\n").last(where: { $0.contains("\"summary\"") }),
               let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
                if let bytes = o["data_added_packed"] as? Int ?? o["data_added"] as? Int {
                    added = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
                }
                if let total = o["total_bytes_processed"] as? Int, let files = o["total_files_processed"] as? Int {
                    whole = "\(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file)), \(files.formatted()) files"
                }
            }
            if ok { _ = Self.run(repo, ["forget", "--tag", "visioncli", "--keep-daily", "7", "--keep-weekly", "4", "--prune"], password: password) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = false
                self.fraction = nil
                if ok {
                    self.lastBackup = Date()
                    log("claude backup: done\(added.isEmpty ? "" : ", \(added) added")")
                    if !whole.isEmpty { UserDefaults.standard.set(whole, forKey: "claudeBackupWhole") }
                    self.refreshStatus(added: added)
                } else {
                    log("claude backup failed: \(r.2.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))")
                    self.status = "Last backup failed: \(Self.failure(r))"
                }
            }
        }
    }

    private func refreshStatus(added: String = "") {
        guard folder != nil else { status = ""; return }
        guard let last = lastBackup else { status = "No backup yet."; return }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        let when = Date().timeIntervalSince(last) < 60 ? "just now" : f.localizedString(for: last, relativeTo: Date())
        // Each snapshot is the whole folder; only the changes since the last one are stored again.
        let whole = UserDefaults.standard.string(forKey: "claudeBackupWhole").map { ": all of ~/.claude (\($0))" } ?? ""
        let new = added.isEmpty ? "" : added == "Zero KB" ? ", nothing changed since the last one" : ", of which \(added) was new"
        status = "Last backup \(when)\(whole)\(new). Keeps 7 daily and 4 weekly snapshots."
    }

    func showBackups() {
        guard let folder else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: folder))
    }

    // MARK: Restore

    /// Pick a snapshot and put it back: the current ~/.claude and ~/.claude.json are moved aside first (to
    /// ~/.claude-before-restore-<date>), so nothing is lost if it was the wrong one.
    func restore() {
        guard let repo, let password = Self.password, !running else { return }
        let r = Self.run(repo, ["snapshots", "--json", "--tag", "visioncli"], password: password)
        guard r.0 == 0, let list = try? JSONSerialization.jsonObject(with: Data(r.1.utf8)) as? [[String: Any]], !list.isEmpty else {
            status = r.0 == 0 ? "No backups to restore yet." : "Couldn't list backups: \(Self.failure(r))"
            return
        }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let shown = DateFormatter()
        shown.dateStyle = .medium
        shown.timeStyle = .short
        let snaps: [(id: String, title: String)] = list.reversed().compactMap { s in
            guard let id = s["short_id"] as? String ?? s["id"] as? String, let t = s["time"] as? String else { return nil }
            // restic writes nanoseconds; ISO8601DateFormatter takes milliseconds.
            let trimmed = t.replacingOccurrences(of: #"(\.\d{3})\d+"#, with: "$1", options: .regularExpression)
            return (id, "\(iso.date(from: trimmed).map { shown.string(from: $0) } ?? t)  ·  \(id)")
        }
        let alert = NSAlert()
        alert.messageText = "Restore Claude from a backup?"
        alert.informativeText = "Quit Claude Code first. Your current ~/.claude and ~/.claude.json are moved to ~/.claude-before-restore-… (not deleted), then the backup is put in their place."
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 300, height: 26))
        popup.addItems(withTitles: snaps.map(\.title))
        alert.accessoryView = popup
        alert.addButton(withTitle: "Restore")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let snap = snaps[popup.indexOfSelectedItem]
        running = true
        status = "Restoring…"
        queue.async { [weak self] in
            let error = Self.unpack(snap.id, repo: repo, password: password)
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = false
                self.fraction = nil
                if let error {
                    log("claude restore failed: \(error)")
                    self.status = "Restore failed: \(error)"
                } else {
                    log("claude restore: snapshot \(snap.id)")
                    self.status = "Restored the backup from \(snap.title). The previous files are in ~/.claude-before-restore-…"
                }
            }
        }
    }

    /// Returns an error message, or nil when it worked.
    private static func unpack(_ id: String, repo: URL, password: String) -> String? {
        let fm = FileManager.default
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        let aside = home.appendingPathComponent(".claude-before-restore-\(f.string(from: Date()))")
        let names = [".claude", ".claude.json"]
        do {
            try fm.createDirectory(at: aside, withIntermediateDirectories: true)
            for name in names where fm.fileExists(atPath: home.appendingPathComponent(name).path) {
                try fm.moveItem(at: home.appendingPathComponent(name), to: aside.appendingPathComponent(name))
            }
        } catch { return error.localizedDescription }
        // Snapshots hold absolute paths, so restoring onto / puts each file back where it was.
        let r = runWithProgress(repo, ["restore", id, "--target", "/", "--json"], password: password) { pct, done, total in
            ClaudeBackup.shared.fraction = pct
            ClaudeBackup.shared.status = progressText("Restoring", pct, done, total)
        }
        if r.0 != 0 {
            // Put the previous files back rather than leave a half-restored folder.
            for name in names {
                try? fm.removeItem(at: home.appendingPathComponent(name))
                try? fm.moveItem(at: aside.appendingPathComponent(name), to: home.appendingPathComponent(name))
            }
            return failure(r)
        }
        return nil
    }
}

/// Settings → Advanced: where Claude backups go, and back up / restore by hand.
struct ClaudeBackupCard: View {
    @ObservedObject var b = ClaudeBackup.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Claude backup").font(.system(size: 13, weight: .semibold)).padding(.leading, 2)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .center, spacing: 16) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Back up ~/.claude daily").font(.system(size: 13))
                        Text(b.folder.map { "To \(($0 as NSString).abbreviatingWithTildeInPath)" } ?? "Everything Claude Code knows (CLAUDE.md, settings, skills, memory, plugins, conversations), encrypted, into a folder you pick such as one in Google Drive. After the first backup, only what changed is added.")
                            .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        if !b.status.isEmpty {
                            Text(b.status).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        if let f = b.fraction { ProgressView(value: f).frame(maxWidth: 260).padding(.top, 2) }
                    }
                    Spacer(minLength: 0)
                    if b.running { ProgressView().controlSize(.small) }
                    Button(b.folder == nil ? "Choose Folder…" : "Change…") { b.chooseFolder() }.disabled(b.running)
                }
                if b.folder != nil {
                    Divider()
                    // One row when there's room, else two (Settings is narrow), never squashed labels.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { mainButtons; Spacer(minLength: 8); otherButtons }
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) { mainButtons }
                            HStack(spacing: 8) { otherButtons }
                        }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .animation(nil, value: b.status)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.035)))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.09), lineWidth: 1))
        }
    }

    @ViewBuilder private var mainButtons: some View {
        Button("Back Up Now") { b.backUp() }.disabled(b.running).fixedSize()
        Button("Restore…") { b.restore() }.disabled(b.running).fixedSize()
        Button("Show Backups") { b.showBackups() }.fixedSize()
    }

    @ViewBuilder private var otherButtons: some View {
        Button("Copy Password") { b.copyPassword() }.fixedSize()
        Button("Turn Off") { b.folder = nil }.disabled(b.running).fixedSize()
    }
}
