import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Network

// Computer control: VisionCLI performs mouse/keyboard/app actions for the AI (it holds the Accessibility permission).
// The MCP server sends actions over a localhost-only HTTP connection authenticated with a per-launch token
// (written to Application Support/visioncli/control.json, readable only by the user).

// MARK: - Local control server

final class ControlServer {
    private var listener: NWListener?
    private let token = UUID().uuidString + UUID().uuidString
    static let infoFile = supportDir.appendingPathComponent("control.json")

    /// Requests are read and handled here, not on the main thread: listing a big app's controls walks its whole
    /// accessibility tree, and actions wait for apps to come forward and type character by character. The handler hops
    /// to main only for UI and app state.
    static let queue = DispatchQueue(label: "dev.visioncli.control", qos: .userInitiated)

    /// handler(request, reply): called on `queue`; reply exactly once (from any queue) with a JSON-able dictionary.
    var handler: (_ request: [String: Any], _ reply: @escaping ([String: Any]) -> Void) -> Void = { _, reply in reply(["error": "not ready"]) }

    func start() {
        do {
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
            let l = try NWListener(using: params)
            l.stateUpdateHandler = { [weak self] state in
                guard let self, case .ready = state, let port = l.port?.rawValue else { return }
                let info: [String: Any] = ["port": Int(port), "token": self.token, "pid": ProcessInfo.processInfo.processIdentifier]
                try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
                if let data = try? JSONSerialization.data(withJSONObject: info) {
                    try? data.write(to: Self.infoFile)
                    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Self.infoFile.path)
                }
                log("control: listening on 127.0.0.1:\(port)")
            }
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.start(queue: Self.queue)
            listener = l
        } catch {
            log("control: couldn't start server: \(error)")
        }
    }

    func stop() {
        listener?.cancel()
        try? FileManager.default.removeItem(at: Self.infoFile)
    }

    private func accept(_ conn: NWConnection) {
        conn.start(queue: Self.queue)
        var buffer = Data()
        func receive() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
                guard let self else { return }
                if let data { buffer.append(data) }
                if let (headers, body) = Self.parse(buffer) {
                    self.respond(conn, headers: headers, body: body)
                } else if done || error != nil {
                    conn.cancel()
                } else {
                    receive()
                }
            }
        }
        receive()
    }

    /// Returns (headers, body) once the full request has arrived.
    private static func parse(_ data: Data) -> ([String: String], Data)? {
        guard let range = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<range.lowerBound], as: UTF8.self)
        var headers: [String: String] = [:]
        for line in head.split(separator: "\r\n").dropFirst() {
            if let i = line.firstIndex(of: ":") {
                headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[range.upperBound...]
        guard body.count >= length else { return nil }
        return (headers, Data(body.prefix(length)))
    }

    private func respond(_ conn: NWConnection, headers: [String: String], body: Data) {
        func send(_ status: String, _ object: [String: Any]) {
            let json = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
            var out = Data("HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n".utf8)
            out.append(json)
            conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
        }
        guard headers["x-visioncli-token"] == token else { send("403 Forbidden", ["error": "bad token"]); return }
        guard let request = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { send("400 Bad Request", ["error": "bad json"]); return }
        handler(request) { send("200 OK", $0) }
    }
}

// MARK: - Actions

enum Computer {
    static var isTrusted: Bool { AXIsProcessTrusted() }

    @discardableResult
    static func requestTrust() -> Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    /// Screen point (top-left global coordinates, as window bounds use) → CGEvent location (same space).
    private static func post(_ type: CGEventType, at p: CGPoint, button: CGMouseButton = .left, clicks: Int = 1) {
        guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        e.post(tap: .cghidEventTap)
    }

    static func move(to p: CGPoint) { post(.mouseMoved, at: p) }

    static func click(at p: CGPoint, button: String = "left", count: Int = 1) {
        move(to: p)
        usleep(40_000)
        let (down, up, b): (CGEventType, CGEventType, CGMouseButton) = button == "right"
            ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        for i in 1...max(1, count) {
            post(down, at: p, button: b, clicks: i)
            usleep(30_000)
            post(up, at: p, button: b, clicks: i)
            usleep(60_000)
        }
    }

    static func drag(from a: CGPoint, to b: CGPoint) {
        move(to: a)
        usleep(50_000)
        post(.leftMouseDown, at: a)
        let steps = 20
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            post(.leftMouseDragged, at: CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
            usleep(12_000)
        }
        post(.leftMouseUp, at: b)
    }

    static func scroll(at p: CGPoint?, dx: Int, dy: Int) {
        if let p { move(to: p); usleep(40_000) }
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    static func type(_ text: String) {
        // Long text: paste it (fast), then put the user's clipboard back.
        if text.count > 300 {
            let pb = NSPasteboard.general
            let saved = pb.string(forType: .string)
            pb.clearContents()
            pb.setString(text, forType: .string)
            _ = press("cmd+v")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                pb.clearContents()
                if let saved { pb.setString(saved, forType: .string) }
            }
            return
        }
        // One Unicode key event per character: apps that read key presses (not text input) only take one each,
        // and it works for any keyboard layout and non-ASCII text.
        for ch in text {
            if ch == "\n" || ch == "\r" { _ = press("return"); usleep(12_000); continue }
            if ch == "\t" { _ = press("tab"); usleep(12_000); continue }
            let units = Array(String(ch).utf16)
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
                units.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                e.post(tap: .cghidEventTap)
            }
            usleep(8_000)
        }
    }

    private static let keyCodes: [String: Int] = [
        "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete, "backspace": kVK_Delete,
        "forwarddelete": kVK_ForwardDelete, "escape": kVK_Escape, "esc": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow,
        "up": kVK_UpArrow, "down": kVK_DownArrow, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8,
        "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
        "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
        "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
        "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
        "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9, "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket,
        "]": kVK_ANSI_RightBracket, ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period,
        "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave,
    ]

    /// "cmd+shift+s", "enter", "ctrl+a" … Returns an error for unknown keys.
    static func press(_ combo: String) -> String? {
        var flags = CGEventFlags()
        var key: Int?
        for part in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command", "⌘": flags.insert(.maskCommand)
            case "shift", "⇧": flags.insert(.maskShift)
            case "alt", "option", "opt", "⌥": flags.insert(.maskAlternate)
            case "ctrl", "control", "⌃": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default:
                guard let code = keyCodes[part] else { return "Unknown key \"\(part)\"" }
                key = code
            }
        }
        guard let code = key else { return "No key in \"\(combo)\"" }
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else { continue }
            e.flags = flags
            e.post(tap: .cghidEventTap)
            usleep(20_000)
        }
        return nil
    }

    static func openApp(_ name: String) -> String? {
        let (status, _, err) = shell("/usr/bin/open", ["-a", name])
        return status == 0 ? nil : "Couldn't open \(name): \(err.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    static func focusApp(_ name: String) -> String? {
        let q = name.lowercased()
        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            ($0.localizedName ?? "").lowercased() == q || ($0.bundleIdentifier ?? "").lowercased() == q
        }) ?? NSWorkspace.shared.runningApplications.first(where: { ($0.localizedName ?? "").lowercased().contains(q) }) else {
            return openApp(name)
        }
        app.activate()
        return nil
    }

    static func openURL(_ s: String) -> String? {
        guard let url = URL(string: s.contains("://") ? s : "https://" + s) else { return "Bad URL" }
        NSWorkspace.shared.open(url)
        return nil
    }

    static var frontApp: NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

    static func runningApp(named name: String) -> NSRunningApplication? {
        let q = name.lowercased()
        let apps = NSWorkspace.shared.runningApplications
        return apps.first { ($0.localizedName ?? "").lowercased() == q || ($0.bundleIdentifier ?? "").lowercased() == q }
            ?? apps.first { ($0.localizedName ?? "").lowercased().contains(q) }
    }
}

// MARK: - Accessibility elements

/// The front app's UI as a list of labelled, clickable/typeable elements (buttons, fields, menus, links, text…).
/// Used only on ControlServer.queue.
final class UIElements {
    private var elements: [Int: AXUIElement] = [:]
    private(set) var appName = ""
    private(set) var app: NSRunningApplication?

    struct Item { let id: Int; let role: String; let label: String; let frame: CGRect; let secure: Bool }

    private static let interesting: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox",
        "AXMenuItem", "AXMenuButton", "AXLink", "AXTab", "AXTabGroup", "AXSlider", "AXIncrementor", "AXDisclosureTriangle",
        "AXCell", "AXRow", "AXStaticText", "AXImage", "AXToolbar", "AXSegmentedControl", "AXSwitch",
    ]

    func list(appNamed name: String?) -> (String, [Item]) {
        elements = [:]
        let app: NSRunningApplication?
        if let name, !name.isEmpty {
            let q = name.lowercased()
            app = NSWorkspace.shared.runningApplications.first { ($0.localizedName ?? "").lowercased().contains(q) }
        } else {
            app = Computer.frontApp
        }
        // Reading our own SwiftUI windows through Accessibility from this (background) queue deadlocks SwiftUI.
        guard let app, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return ("", []) }
        self.app = app
        appName = app.localizedName ?? ""
        let root = AXUIElementCreateApplication(app.processIdentifier)
        // A hung app would otherwise stall each call for the default ~6s (and the control queue with it).
        AXUIElementSetMessagingTimeout(root, 0.5)
        var start: CFTypeRef?
        let window = AXUIElementCopyAttributeValue(root, kAXFocusedWindowAttribute as CFString, &start) == .success
            ? (start as! AXUIElement) : root
        var items: [Item] = []
        var nextId = 1
        var visited = 0
        let deadline = Date().addingTimeInterval(4)
        func walk(_ el: AXUIElement, _ depth: Int) {
            // Huge trees (big web pages, long tables) mostly hold uninteresting nodes: cap the nodes visited too.
            guard depth < 30, items.count < 350, visited < 5000, visited % 64 != 0 || Date() < deadline else { return }
            visited += 1
            AXUIElementSetMessagingTimeout(el, 0.5)
            let role = Self.string(el, kAXRoleAttribute) ?? ""
            if Self.interesting.contains(role), let frame = Self.frame(el), frame.width > 1, frame.height > 1 {
                let label = [Self.string(el, kAXTitleAttribute), Self.string(el, kAXDescriptionAttribute),
                             Self.string(el, kAXValueAttribute), Self.string(el, kAXPlaceholderValueAttribute),
                             Self.string(el, kAXHelpAttribute)]
                    .compactMap { $0 }.first { !$0.isEmpty } ?? ""
                if !(role == "AXStaticText" && label.isEmpty) && !(role == "AXImage" && label.isEmpty) {
                    let secure = (Self.string(el, kAXSubroleAttribute) ?? "") == "AXSecureTextField"
                    items.append(Item(id: nextId, role: role.replacingOccurrences(of: "AX", with: ""),
                                      label: secure ? "(password field)" : String(label.prefix(100)), frame: frame, secure: secure))
                    elements[nextId] = el
                    nextId += 1
                }
            }
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success, let kids = children as? [AXUIElement] {
                for kid in kids { walk(kid, depth + 1) }
            }
        }
        walk(window, 0)
        return (appName, items)
    }

    func element(_ id: Int) -> AXUIElement? { elements[id] }

    func isSecure(_ id: Int) -> Bool {
        guard let el = elements[id] else { return false }
        return (Self.string(el, kAXSubroleAttribute) ?? "") == "AXSecureTextField"
    }

    func label(_ id: Int) -> String {
        guard let el = elements[id] else { return "element \(id)" }
        let role = (Self.string(el, kAXRoleAttribute) ?? "").replacingOccurrences(of: "AX", with: "").lowercased()
        let text = [Self.string(el, kAXTitleAttribute), Self.string(el, kAXDescriptionAttribute), Self.string(el, kAXValueAttribute)]
            .compactMap { $0 }.first { !$0.isEmpty } ?? ""
        return text.isEmpty ? role : "\"\(text.prefix(40))\" \(role)"
    }

    func center(_ id: Int) -> CGPoint? {
        guard let el = elements[id], let f = Self.frame(el) else { return nil }
        return CGPoint(x: f.midX, y: f.midY)
    }

    /// Press via Accessibility (no mouse needed); false if the element doesn't support it.
    func press(_ id: Int) -> Bool {
        guard let el = elements[id] else { return false }
        // Back to the normal timeout: a press that opens a dialog can take a while to return, and a timeout here would
        // fall back to a real click and press it twice.
        AXUIElementSetMessagingTimeout(el, 0)
        return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
    }

    /// Focus a text field and set its value directly.
    func setText(_ id: Int, _ text: String) -> Bool {
        guard let el = elements[id] else { return false }
        AXUIElementSetMessagingTimeout(el, 0)
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString) == .success
    }

    private static func string(_ el: AXUIElement, _ attr: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    private static func frame(_ el: AXUIElement) -> CGRect? {
        var p: CFTypeRef?, s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &s) == .success else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &point)
        AXValueGetValue(s as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }
}

// MARK: - App side: approvals, kill switch, status

/// What the MCP server asks for (the request's "action"). src/ mirrors these raw values, and a test there reads this
/// case list, so keep one `case` per line right under the declaration.
enum ControlAction: String, CaseIterable {
    case status
    case displays
    case announce
    case capture
    case elements
    case click
    case type
    case key
    case scroll
    case drag
    case openApp = "open_app"
    case focusApp = "focus_app"
    case openURL = "open_url"

    /// Keys and typing go to the app the assistant is working in.
    var usesKeyboard: Bool { self == .type || self == .key }
}

/// Apps where every action asks first, even with "Allow all".
private let sensitiveApps: Set<String> = [
    "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
    "com.dashlane.Dashlane", "com.apple.Terminal.sudo",
]

extension AppDelegate {
    /// True while the AI is in the middle of using the computer (Esc then stops it).
    var controlActive: Bool { Date().timeIntervalSince(controlLastAction) < 30 || pendingControl != nil }

    func startComputerControl() {
        controlServer.handler = { [weak self] request, reply in
            guard let self else { reply(["error": "VisionCLI is shutting down"]); return }
            self.handleControl(request, reply: reply)
        }
        controlServer.start()
        taskHUD.onStop = { [weak self] in
            guard let self else { return }
            self.stopComputerControl()
            if let s = self.current, s.busy { s.stop() }
        }
        taskHUD.onPause = { [weak self] paused in
            guard let self, !paused else { return }
            let held = self.pausedActions
            self.pausedActions = []
            held.forEach { $0(true) }
        }
    }

    func startCrashWatcher() {
        crashWatcher.onCrash = { [weak self] crash in
            guard let self, self.state.phase == .hidden else { return }
            self.state.question = "\(crash.app) crashed"
            self.flash("\(crash.app) just crashed. Hold ⌥ and ask \"why did it crash?\".", seconds: 9)
        }
        if Settings.watchCrashes { crashWatcher.start() }
    }

    func stopComputerControl() {
        controlStopped = Date()
        controlLastAction = .distantPast
        if let done = pendingControl {
            pendingControl = nil
            state.permission = nil
            done(false)
        }
        controlQueue.removeAll()
        let held = pausedActions
        pausedActions = []
        held.forEach { $0(false) }
        taskHUD.update(taskHUD.begin("Stopped by you"), .declined)
        taskHUD.state.paused = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.taskHUD.hide() }
        log("control: stopped by Esc")
        state.question = "Computer control"
        flash("Stopped. The assistant won't touch your computer again until your next question.", seconds: 3)
    }

    /// Write where each attached screenshot sits on screen, so the MCP server can turn image pixels into clicks.
    func writeShotMap(_ shots: [Shot]) {
        let list: [[String: Any]] = shots.map {
            ["x": $0.screenRect.minX, "y": $0.screenRect.minY, "width": $0.screenRect.width, "height": $0.screenRect.height,
             "imageWidth": $0.pixelSize.width, "imageHeight": $0.pixelSize.height, "label": $0.label]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["shots": list, "time": Date().timeIntervalSince1970]) {
            try? data.write(to: supportDir.appendingPathComponent("shots.json"))
        }
    }

    /// Called on ControlServer.queue. Accessibility reads and the actions themselves run there; app state (stop,
    /// approvals, the task panel, hotkeys, the bubble) is only touched on the main thread.
    func handleControl(_ r: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let action = r["action"] as? String ?? ""
        let kind = ControlAction(rawValue: action) // nil: unknown, refused by perform after the usual checks
        func num(_ k: String) -> CGFloat? { (r[k] as? NSNumber).map { CGFloat($0.doubleValue) } }
        func point(_ xk: String = "x", _ yk: String = "y") -> CGPoint? {
            guard let x = num(xk), let y = num(yk) else { return nil }
            return CGPoint(x: x, y: y)
        }

        // Read-only requests: no approval, work even when control is off.
        switch kind {
        case .announce:
            // The assistant reporting back later on its own (background work done): bubble + speech.
            let text = r["text"] as? String ?? ""
            DispatchQueue.main.async { self.announce(text); reply(["ok": true]) }
            return
        case .status:
            DispatchQueue.main.async {
                reply(["trusted": Computer.isTrusted, "mode": Settings.computerControl,
                       "frontApp": Computer.frontApp?.localizedName ?? "", "stopped": self.controlStopped != nil])
            }
            return
        case .displays:
            DispatchQueue.main.async {
                let primary = Geometry.primaryHeight
                let mouse = Geometry.pointer // top-left points
                var out: [String: Any] = ["displays": NSScreen.screens.map { s in
                    ["x": s.frame.minX, "y": primary - s.frame.maxY, "width": s.frame.width, "height": s.frame.height]
                }, "pointer": ["x": mouse.x, "y": mouse.y]]
                // `look` asks for the window list here too, instead of a slower osascript call.
                if (r["windows"] as? Bool) == true {
                    out["windows"] = Screen.windows().map { w in // front-most first
                        ["id": Int(w.id), "app": w.app, "title": w.title, "pid": Int(w.pid),
                         "bounds": ["x": w.bounds.minX, "y": w.bounds.minY, "width": w.bounds.width, "height": w.bounds.height]]
                    }
                }
                reply(out)
            }
            return
        case .capture:
            // Fast screenshot for the `look` tool (ScreenCaptureKit, in memory). window_id, or x/y/width/height
            // (top-left points, e.g. a whole display).
            let windowId = (r["window_id"] as? NSNumber).map { CGWindowID($0.uint32Value) }
            let rect = num("width").map { w in CGRect(x: num("x") ?? 0, y: num("y") ?? 0, width: w, height: num("height") ?? 0) }
            let window = windowId.flatMap { id in Screen.windows().first { $0.id == id } }
            let what = window?.app ?? "the screen"
            DispatchQueue.main.async { ActivityBadge.shared.show("camera.viewfinder", "Taking a screenshot of \(what)") }
            let image: CGImage?
            if let windowId {
                image = FastCapture.window(windowId, bounds: window?.bounds ?? .zero)
            } else if let rect {
                image = FastCapture.area(rect)
            } else {
                image = nil
            }
            guard let image, let jpeg = Screen.jpeg(image) else { reply(["error": "capture unavailable"]); return }
            reply(["data": jpeg.0.base64EncodedString(), "width": Int(jpeg.1.width), "height": Int(jpeg.1.height)])
            return
        case .elements:
            guard Computer.isTrusted else { reply(needTrust()); return }
            let (app, items) = uiElements.list(appNamed: r["app"] as? String)
            let target = uiElements.app
            DispatchQueue.main.async { self.controlTarget = target }
            reply(["app": app, "elements": items.map {
                ["id": $0.id, "role": $0.role, "label": $0.label,
                 "x": Int($0.frame.midX), "y": Int($0.frame.midY), "w": Int($0.frame.width), "h": Int($0.frame.height)]
            }])
            return
        default: break
        }

        if Settings.computerControl == "off" {
            reply(["error": "Computer control is turned off in VisionCLI (VisionCLI menu → Settings… → Computer Control). Ask the user to turn it on."]); return
        }
        guard Computer.isTrusted else { reply(needTrust()); return }

        // Resolve the target here (Accessibility calls into other apps can be slow), then decide on main.
        let element = (r["element"] as? NSNumber)?.intValue
        var target = point()
        if let element { target = uiElements.center(element) }
        let elementApp = element != nil ? uiElements.app : nil
        let elementLabel = element.map { uiElements.label($0) }
        let secureTarget = (element.map { uiElements.isSecure($0) } ?? false)
            || (kind == .type && focusedIsSecure())
            || (target.map { isSecure(at: $0) } ?? false)
        let resolvedTarget = target
        DispatchQueue.main.async {
            self.decideControl(action, r, target: resolvedTarget, element: element, elementApp: elementApp,
                               elementLabel: elementLabel, secureTarget: secureTarget, reply: reply)
        }
    }

    /// Main thread: refuse after an Esc stop, describe the action, ask for approval when needed, then run it.
    private func decideControl(_ action: String, _ r: [String: Any], target: CGPoint?, element: Int?, elementApp: NSRunningApplication?,
                               elementLabel: String?, secureTarget: Bool, reply: @escaping ([String: Any]) -> Void) {
        let kind = ControlAction(rawValue: action)
        func num(_ k: String) -> CGFloat? { (r[k] as? NSNumber).map { CGFloat($0.doubleValue) } }
        if let stopped = controlStopped, Date().timeIntervalSince(stopped) < 120 {
            reply(["error": "The user pressed Esc to stop you using the computer. Stop and ask them how to continue."]); return
        }
        controlStopped = nil

        // Keys and typing go to the app the assistant is working in (an Accessibility press doesn't bring it
        // forward, so otherwise they'd land in whatever is in front, e.g. the terminal).
        if kind?.usesKeyboard == true {
            if let name = r["app"] as? String, !name.isEmpty { controlTarget = Computer.runningApp(named: name) ?? controlTarget }
            if element != nil, let a = elementApp { controlTarget = a }
        }
        let keyboardTarget = kind?.usesKeyboard == true ? controlTarget.flatMap { $0.isTerminated ? nil : $0 } : nil
        let app = keyboardTarget ?? Computer.frontApp

        // In Chrome/Brave the browser_* tools are exact and fast; keyboard navigation there opened stray tabs/windows
        // and typed into whichever window happened to be in front.
        let browserIds: Set<String> = ["com.google.Chrome", "com.brave.Browser", "com.google.Chrome.canary", "com.brave.Browser.beta"]
        if kind == .key, browserIds.contains(app?.bundleIdentifier ?? ""),
           let keys = (r["keys"] as? String)?.lowercased().replacingOccurrences(of: " ", with: ""),
           ["cmd+l", "cmd+t", "cmd+n", "cmd+shift+n", "command+l", "command+t", "command+n"].contains(where: { keys.contains($0) }) {
            reply(["error": "Don't use keyboard shortcuts to open or navigate pages in \(app?.localizedName ?? "the browser"). Use browser_open (reuses tabs), browser_navigate, browser_switch_tab, browser_elements + browser_click/browser_type/browser_select. Use click/type_text only for things those can't reach (canvas, cross-origin frames, browser dialogs)."])
            return
        }
        let appName = app?.localizedName ?? "the front app"
        let what: String = {
            let on = elementLabel ?? target.map { "(\(Int($0.x)), \(Int($0.y)))" } ?? ""
            switch kind {
            case .click:
                let click = (r["button"] as? String) == "right" ? "right-click" : ((r["count"] as? Int ?? 1) >= 2 ? "double-click" : "click")
                return "\(click) \(on) in \(appName)"
            case .type:
                let t = r["text"] as? String ?? ""
                return "type \"\(t.count > 60 ? String(t.prefix(60)) + "…" : t)\"\(element != nil ? " into \(on)" : "") in \(appName)"
            case .key: return "press \(r["keys"] as? String ?? "") in \(appName)"
            case .scroll: return "scroll in \(appName)"
            case .drag: return "drag from (\(Int(num("x1") ?? 0)), \(Int(num("y1") ?? 0))) to (\(Int(num("x2") ?? 0)), \(Int(num("y2") ?? 0))) in \(appName)"
            case .openApp: return "open \(r["name"] as? String ?? "an app")"
            case .focusApp: return "switch to \(r["name"] as? String ?? "an app")"
            case .openURL: return "open \(r["url"] as? String ?? "a link")"
            default: return action
            }
        }()

        let sensitive = sensitiveApps.contains(app?.bundleIdentifier ?? "") || secureTarget
        let allowed = Settings.computerControl == "auto" || (controlAllowUntil.map { Date() < $0 } ?? false)

        let label = what.prefix(1).uppercased() + what.dropFirst()
        var run: () -> Void = {}
        run = { [weak self] in
            guard let self else { return }
            // Paused from the task panel: hold the action until Resume (or drop it on Stop).
            if self.taskHUD.state.paused {
                self.pausedActions.append { go in
                    if go { run() } else { reply(["error": "The user stopped the task. Stop and ask them how to continue."]) }
                }
                return
            }
            self.controlLastAction = Date()
            self.hotkeys.set(.dismiss, true) // Esc = stop, while the assistant is acting
            let step = self.taskHUD.begin(label)
            self.showControlStatus(label + "…")
            // Our own Esc hotkey would swallow a synthetic Escape.
            let isEsc = kind == .key && (r["keys"] as? String ?? "").lowercased().contains("esc")
            if isEsc { self.hotkeys.set(.dismiss, false) }
            // The action itself (waiting for the app to come forward, typing, dragging…) runs off the main thread.
            ControlServer.queue.async {
                if let k = keyboardTarget, Computer.frontApp?.processIdentifier != k.processIdentifier {
                    k.activate()
                    for _ in 0..<20 where Computer.frontApp?.processIdentifier != k.processIdentifier { usleep(50_000) }
                    usleep(150_000)
                }
                let error = self.perform(action, r, target: target, element: element)
                var opened: NSRunningApplication??
                if error == nil, kind == .openApp || kind == .focusApp, let name = r["name"] as? String {
                    opened = .some(Computer.runningApp(named: name))
                }
                DispatchQueue.main.async {
                    if isEsc { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.hotkeys.set(.dismiss, true) } }
                    if let opened { self.controlTarget = opened }
                    self.controlLastAction = Date()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { // let the UI react before the next look
                        self.taskHUD.update(step, error == nil ? .done : .failed)
                        if let error { reply(["error": error]) }
                        else { reply(["ok": true, "done": what, "frontApp": Computer.frontApp?.localizedName ?? ""]) }
                        self.releaseEscIfIdle()
                    }
                }
            }
        }

        if allowed && !sensitive { run(); return }
        let waiting = taskHUD.begin("Waiting for you: \(label)", waiting: true)
        askApproval(what: what, sensitive: sensitive, request: r) { [weak self] ok in
            self?.taskHUD.update(waiting, ok ? .done : .declined)
            if ok { run() } else { reply(["error": "The user declined: \(what). Don't retry it; ask what they'd like instead."]) }
        }
    }

    private func needTrust() -> [String: Any] {
        DispatchQueue.main.async { Computer.requestTrust() }
        return ["error": "VisionCLI needs the Accessibility permission to use the computer. macOS just asked the user; they should turn VisionCLI on in System Settings → Privacy & Security → Accessibility, then try again."]
    }

    /// Runs on ControlServer.queue (it waits between events, and uiElements belongs to that queue).
    private func perform(_ action: String, _ r: [String: Any], target: CGPoint?, element: Int?) -> String? {
        guard let kind = ControlAction(rawValue: action) else { return "Unknown action \(action)." }
        switch kind {
        case .click:
            let button = r["button"] as? String ?? "left"
            let count = (r["count"] as? NSNumber)?.intValue ?? 1
            // Prefer pressing the element through Accessibility (exact, no mouse needed); fall back to a real click.
            if let element, button == "left", count == 1, uiElements.press(element) { return nil }
            guard let target else { return element != nil ? "That element is gone; call ui_elements again." : "Missing x/y or element." }
            Computer.click(at: target, button: button, count: count)
        case .type:
            guard let text = r["text"] as? String else { return "Missing text." }
            if let element {
                if (r["replace"] as? Bool ?? false), uiElements.setText(element, text) { return nil }
                if let c = uiElements.center(element) { Computer.click(at: c) ; usleep(120_000) }
            }
            Computer.type(text)
        case .key:
            guard let keys = r["keys"] as? String else { return "Missing keys." }
            for combo in keys.split(separator: " ") {
                if let err = Computer.press(String(combo)) { return err }
                usleep(60_000)
            }
        case .scroll:
            Computer.scroll(at: target, dx: (r["dx"] as? NSNumber)?.intValue ?? 0, dy: (r["dy"] as? NSNumber)?.intValue ?? -5)
        case .drag:
            guard let a = (r["x1"] as? NSNumber).flatMap({ x in (r["y1"] as? NSNumber).map { CGPoint(x: x.doubleValue, y: $0.doubleValue) } }),
                  let b = (r["x2"] as? NSNumber).flatMap({ x in (r["y2"] as? NSNumber).map { CGPoint(x: x.doubleValue, y: $0.doubleValue) } })
            else { return "Missing x1/y1/x2/y2." }
            Computer.drag(from: a, to: b)
        case .openApp:
            guard let name = r["name"] as? String else { return "Missing name." }
            return Computer.openApp(name)
        case .focusApp:
            guard let name = r["name"] as? String else { return "Missing name." }
            return Computer.focusApp(name)
        case .openURL:
            guard let url = r["url"] as? String else { return "Missing url." }
            return Computer.openURL(url)
        case .status, .displays, .announce, .capture, .elements:
            return "Unknown action \(action)." // answered in handleControl; never performed
        }
        return nil
    }

    private func askApproval(what: String, sensitive: Bool, request: [String: Any], done: @escaping (Bool) -> Void) {
        // One card at a time; later actions wait their turn.
        if pendingControl != nil || state.phase == .approval {
            controlQueue.append { [weak self] in self?.askApproval(what: what, sensitive: sensitive, request: request, done: done) }
            return
        }
        controlLastAction = Date()
        var detail: [(String, DiffKind)] = []
        if let t = request["text"] as? String { detail.append(contentsOf: t.components(separatedBy: "\n").prefix(6).map { ($0, .added) }) }
        if sensitive { detail.append(("Sensitive: passwords, payments or system settings. Check carefully.", .removed)) }
        detail.append(("Esc stops the assistant from using your computer.", .context))
        let name = Settings.assistant.name
        state.permission = PermissionRequest(id: UUID().uuidString, tool: "computer", input: request,
                                             customTitle: "\(name) wants to \(what)", customDetail: detail)
        state.question = state.question.isEmpty ? "Computer control" : state.question
        pendingControl = done
        speaker.reset()
        set(.approval)
        panel.makeKey()
    }

    func finishControlApproval(_ allow: Bool, always: Bool, done: @escaping (Bool) -> Void) {
        if allow && always { controlAllowUntil = Date().addingTimeInterval(15 * 60) }
        state.permission = nil
        activity.permission("Computer: \(allow ? "allowed" : "denied")", allowed: allow)
        if let s = current, s.busy { state.status = allow ? "Working…" : "OK, skipping that…"; set(.thinking) }
        else { set(.hidden) }
        done(allow)
        if !controlQueue.isEmpty { let next = controlQueue.removeFirst(); DispatchQueue.main.async { next() } }
    }

    /// The step being performed, in the bubble.
    private func showControlStatus(_ text: String) {
        log("control: \(text)")
        activity.text("\n> \(text)\n")
        ActivityBadge.shared.show("cursorarrow.motionlines", text.prefix(1).uppercased() + text.dropFirst() + " · esc stops", tint: .purple, seconds: 4)
        ActivityBadge.shared.controlling()
        switch state.phase {
        case .thinking, .listening: state.status = text
        case .answering: state.toast = text
        case .hidden, .error:
            state.question = "Computer control"
            flash(text + "  (esc stops)", seconds: 2.5)
        default: break
        }
    }

    private func releaseEscIfIdle() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 31) { [weak self] in
            guard let self, !self.controlActive, self.state.phase == .hidden else { return }
            self.hotkeys.set(.dismiss, false)
        }
    }

    /// An app's accessibility root with a short timeout, so a hung app can't stall the control queue for seconds.
    /// (A timeout set on the system-wide element would change it for every Accessibility call VisionCLI makes.)
    private func axApp(_ pid: pid_t) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        return app
    }

    private func focusedIsSecure() -> Bool {
        guard let front = Computer.frontApp else { return false }
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp(front.processIdentifier), kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused else { return false }
        let el = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(el, 0.5)
        var sub: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &sub)
        return (sub as? String) == "AXSecureTextField"
    }

    private func isSecure(at p: CGPoint) -> Bool {
        // Hit-test in the app that owns the window there (the front app if it's a menu, sheet or other small window).
        guard let pid = Screen.windows().first(where: { $0.bounds.contains(p) })?.pid ?? Computer.frontApp?.processIdentifier else { return false }
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(axApp(pid), Float(p.x), Float(p.y), &el) == .success, let el else { return false }
        AXUIElementSetMessagingTimeout(el, 0.5)
        var sub: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &sub)
        return (sub as? String) == "AXSecureTextField"
    }
}
