import Foundation

/// Local mode: the whole JARVIS on this Mac.
///
/// Runs `npm start` (scripts/start.mjs: the bridge and the interface together)
/// from a checkout of the repository, and pairs this app's hands with that
/// bridge so nobody has to copy a token between two windows on one machine.
///
/// Commands go through a login shell, so Node is found wherever the user
/// installed it — Homebrew, nvm, the official installer — exactly as it is in
/// their own Terminal. Paths and names reach the shell as environment
/// variables, never spliced into the command line.
final class LocalBridge {
    static let bridgeURL = URL(string: "http://127.0.0.1:8787/health")!
    static let faceURL = URL(string: "http://localhost:5173/")!
    static let deviceURL = URL(string: "ws://127.0.0.1:8787/device")!

    private var process: Process?
    let logFile: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/JARVIS", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("bridge.log")
    }()

    enum Failure: Error, CustomStringConvertible {
        case noRepo(String)
        case noModules(String)
        case noNode
        case timedOut(String)
        case pairing(String)

        var description: String {
            switch self {
            case .noRepo(let p): return "Não encontrei o projeto do JARVIS em \(p). Escolha a pasta certa em Configurações."
            case .noModules(let p): return "Falta instalar as dependências. No Terminal: cd \"\(p)\" && npm install"
            case .noNode: return "O Node.js não foi encontrado. Instale-o em nodejs.org (versão 20 ou mais nova)."
            case .timedOut(let log): return "A ponte não respondeu a tempo. Veja o registro em \(log)."
            case .pairing(let why): return "Não consegui parear este Mac com a ponte local: \(why)"
            }
        }
    }

    var running: Bool { process?.isRunning ?? false }

    /// Starts the bridge and the interface unless they are already up (say,
    /// from `npm start` in a Terminal), and waits until both answer.
    /// Blocking — call it off the main thread.
    func ensureRunning(repo: String, writes: Bool) throws {
        try check(repo)
        if !(Self.answers(Self.bridgeURL) && Self.answers(Self.faceURL)) {
            if !running { try launch(repo: repo, writes: writes) }
            let deadline = Date().addingTimeInterval(90)
            while !(Self.answers(Self.bridgeURL) && Self.answers(Self.faceURL)) {
                if Date() > deadline { throw Failure.timedOut(logFile.path) }
                if let p = process, !p.isRunning { throw Failure.timedOut(logFile.path) }
                Thread.sleep(forTimeInterval: 0.7)
            }
        }
    }

    /// A token for this Mac on the local bridge (npm run pair -- --mac --json).
    func pair(repo: String, name: String) throws -> String {
        try check(repo)
        let r = Self.login(
            "cd \"$JARVIS_REPO\" && exec node scripts/pair.mjs --mac --json --replace \"$JARVIS_NAME\"",
            env: ["JARVIS_REPO": repo, "JARVIS_NAME": name]
        )
        guard r.status == 0,
              let line = r.out.split(separator: "\n").last(where: { $0.hasPrefix("{") }),
              let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let token = obj["token"] as? String
        else { throw Failure.pairing(r.err.isEmpty ? "resposta inesperada" : r.err) }
        return token
    }

    func stop() {
        guard let p = process, p.isRunning else { return }
        // start.mjs takes SIGTERM as the cue to stop both halves.
        p.terminate()
        process = nil
    }

    // MARK: -

    private func check(_ repo: String) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: "\(repo)/scripts/start.mjs") else { throw Failure.noRepo(repo) }
        guard fm.fileExists(atPath: "\(repo)/node_modules") else { throw Failure.noModules(repo) }
        guard Self.login("command -v node", env: [:]).status == 0 else { throw Failure.noNode }
    }

    private func launch(repo: String, writes: Bool) throws {
        FileManager.default.createFile(atPath: logFile.path, contents: nil)
        let log = try FileHandle(forWritingTo: logFile)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // exec: node replaces the shell, so terminate() reaches start.mjs itself.
        p.arguments = ["-lc", "cd \"$JARVIS_REPO\" && exec node scripts/start.mjs \(writes ? "--writes" : "")"]
        var env = ProcessInfo.processInfo.environment
        env["JARVIS_REPO"] = repo
        // The colour codes start.mjs paints its labels with are noise in a file.
        env["NO_COLOR"] = "1"
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        try p.run()
        process = p
    }

    /// Something answers at `url` (any HTTP status counts — it is alive).
    static func answers(_ url: URL) -> Bool {
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        let done = DispatchSemaphore(value: 0)
        var alive = false
        URLSession.shared.dataTask(with: req) { _, response, _ in
            alive = response is HTTPURLResponse
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return alive
    }

    struct Output { let status: Int32; let out: String; let err: String }

    static func login(_ command: String, env extra: [String: String]) -> Output {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", command]
        var env = ProcessInfo.processInfo.environment
        for (k, v) in extra { env[k] = v }
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return Output(status: -1, out: "", err: error.localizedDescription) }
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return Output(
            status: p.terminationStatus,
            out: String(decoding: o, as: UTF8.self),
            err: String(decoding: e, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}
