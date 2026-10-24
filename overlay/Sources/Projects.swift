import Foundation

/// Maps the window under the pointer to a project folder, so voice mode follows you between projects.
///
/// Known projects come from JetBrains "recent projects" (PhpStorm, IntelliJ, …), VS Code/Cursor/Windsurf
/// recents, and the usual code folders (~/projects, ~/PhpstormProjects, ~/Developer, …). Window titles are
/// split into tokens (e.g. PhpStorm "myshop – payments", VS Code "file.ts — myapp — Visual Studio Code")
/// and matched by folder name.
final class ProjectResolver {
    private var byName: [String: String] = [:] // lowercased folder name → path (first source wins)
    private var lastRefresh = Date.distantPast
    private let fm = FileManager.default

    private let roots = ["projects", "Projects", "PhpstormProjects", "IdeaProjects", "WebstormProjects", "PycharmProjects",
                         "GolandProjects", "RiderProjects", "AndroidStudioProjects", "Developer", "dev", "code", "Code", "src",
                         "workspace", "repos", "Sites", "Documents/GitHub", "Documents/Projects", "Desktop"]

    /// Rebuilds the index in the background (scanning folders takes a few seconds); lookups use the last index meanwhile.
    func refreshIfStale() {
        guard Date().timeIntervalSince(lastRefresh) > 300 else { return }
        lastRefresh = Date()
        DispatchQueue.global(qos: .utility).async {
            let map = self.buildIndex()
            DispatchQueue.main.async {
                self.byName = map
                log("projects indexed: \(map.count)")
            }
        }
    }

    private func buildIndex() -> [String: String] {
        let fm = FileManager()
        var found: [String] = []
        found += jetbrainsRecents()
        found += vscodeRecents()
        for root in roots {
            let dir = home.appendingPathComponent(root)
            guard let kids = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: .skipsHiddenFiles) else { continue }
            for kid in kids where kid.hasDirectoryPath {
                found.append(kid.path)
                // One level deeper for grouped layouts like ~/projects/ios/MyApp.
                if let grand = try? fm.contentsOfDirectory(at: kid, includingPropertiesForKeys: nil, options: .skipsHiddenFiles), grand.count < 60 {
                    found += grand.filter { $0.hasDirectoryPath && isProject($0.path) }.map(\.path)
                }
            }
        }
        var map: [String: String] = [:]
        for path in found where fm.fileExists(atPath: path) {
            let key = (path as NSString).lastPathComponent.lowercased()
            if map[key] == nil { map[key] = path }
        }
        return map
    }

    func project(for window: WinInfo?) -> String? {
        guard let window, !window.title.isEmpty else { return nil }
        refreshIfStale()
        for token in tokens(window.title) {
            // Some IDEs show the path itself, e.g. "myshop [~/PhpstormProjects/myshop]".
            if token.hasPrefix("/") || token.hasPrefix("~") {
                let path = (token as NSString).expandingTildeInPath
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: path, isDirectory: &isDir) {
                    return gitRoot(isDir.boolValue ? path : (path as NSString).deletingLastPathComponent)
                }
            }
            if let path = byName[token.lowercased()] { return path }
        }
        return nil
    }

    /// Projects of the windows currently on screen (editors etc.), front-most first.
    func openWindowProjects() -> [String] {
        var out: [String] = []
        for w in Screen.windows() where !w.isTerminal {
            if let p = project(for: w), !out.contains(p) { out.append(p) }
        }
        return out
    }

    private func tokens(_ title: String) -> [String] {
        var out: [String] = []
        if let r = title.range(of: #"\[([^\]]+)\]"#, options: .regularExpression) {
            out.append(String(title[r].dropFirst().dropLast()))
        }
        let cleaned = title.replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        for part in cleaned.components(separatedBy: CharacterSet(charactersIn: "–—|")) .flatMap({ $0.components(separatedBy: " - ") }) {
            let t = part.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "●•*"))
                .trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { out.append(t) }
        }
        return out
    }

    private func isProject(_ path: String) -> Bool {
        let markers = [".git", "package.json", "composer.json", "Package.swift", "Podfile", "build.gradle", "pubspec.yaml", "Cargo.toml", "go.mod", "pyproject.toml"]
        if markers.contains(where: { fm.fileExists(atPath: "\(path)/\($0)") }) { return true }
        let kids = (try? fm.contentsOfDirectory(atPath: path)) ?? []
        return kids.contains { $0.hasSuffix(".xcodeproj") || $0.hasSuffix(".xcworkspace") }
    }

    func gitRoot(_ path: String) -> String {
        var dir = path
        while dir != "/" && dir != home.path {
            if fm.fileExists(atPath: "\(dir)/.git") { return dir }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return path
    }

    private func jetbrainsRecents() -> [String] {
        let base = home.appendingPathComponent("Library/Application Support/JetBrains")
        let products = (try? fm.contentsOfDirectory(atPath: base.path)) ?? []
        var paths: [String] = []
        for product in products.sorted(by: >) { // newest versions first
            let file = base.appendingPathComponent("\(product)/options/recentProjects.xml")
            guard let xml = try? String(contentsOf: file, encoding: .utf8) else { continue }
            let re = try! NSRegularExpression(pattern: #"<entry key="([^"]+)""#)
            for m in re.matches(in: xml, range: NSRange(xml.startIndex..., in: xml)) {
                if let r = Range(m.range(at: 1), in: xml) {
                    paths.append(String(xml[r]).replacingOccurrences(of: "$USER_HOME$", with: home.path))
                }
            }
        }
        return paths
    }

    private func vscodeRecents() -> [String] {
        let editors = ["Code", "Cursor", "Windsurf", "VSCodium"]
        var paths: [String] = []
        for editor in editors {
            let file = home.appendingPathComponent("Library/Application Support/\(editor)/User/globalStorage/storage.json")
            guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
            let re = try! NSRegularExpression(pattern: #"file://(/[^"]+)"#)
            for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                if let r = Range(m.range(at: 1), in: text), let p = String(text[r]).removingPercentEncoding { paths.append(p) }
            }
        }
        return paths
    }
}
