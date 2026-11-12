import Foundation
import Network

/// Serves the interface from inside the app bundle, on 127.0.0.1 only.
///
/// Paired mode needs the interface without a dev server on this Mac. It could
/// be loaded from file:// or a custom URL scheme, but neither counts as a
/// secure context — and the microphone, the one thing JARVIS cannot do
/// without, is only offered to secure contexts. http://127.0.0.1 is one.
///
/// A fixed port (with a fallback) so the page keeps one origin between runs,
/// and with it whatever it saved in its own storage.
final class StaticServer {
    private let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "app.jarvis.mac.static")
    private(set) var port: UInt16 = 0

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    /// Starts listening and returns the port, or nil if nothing would bind.
    func start(preferred: UInt16 = 47811) -> UInt16? {
        if port != 0 { return port }
        for candidate in [preferred, 0] {
            if let p = listen(on: candidate) {
                port = p
                return p
            }
        }
        return nil
    }

    func stop() {
        listener?.cancel()
        listener = nil
        port = 0
    }

    private func listen(on candidate: UInt16) -> UInt16? {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = .hostPort(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(rawValue: candidate) ?? .any
        )
        guard let l = try? NWListener(using: params) else { return nil }
        let ready = DispatchSemaphore(value: 0)
        var bound: UInt16?
        l.stateUpdateHandler = { state in
            switch state {
            case .ready:
                bound = l.port?.rawValue
                ready.signal()
            case .failed, .cancelled:
                ready.signal()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 3)
        guard let bound, bound != 0 else {
            l.cancel()
            return nil
        }
        listener = l
        return bound
    }

    // MARK: - one request per connection

    private func accept(_ conn: NWConnection) {
        // Loopback only, whatever the listener was able to promise.
        if case let .hostPort(host, _) = conn.endpoint {
            let h = "\(host)"
            if !(h == "127.0.0.1" || h.hasPrefix("::1") || h.hasPrefix("::ffff:127.") || h == "localhost") {
                conn.cancel()
                return
            }
        }
        conn.start(queue: queue)
        read(conn, buffer: Data())
    }

    private func read(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, error in
            guard let self else { return conn.cancel() }
            var buf = buffer
            if let data { buf.append(data) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
                self.respond(conn, head: head)
            } else if done || error != nil || buf.count > 256 * 1024 {
                conn.cancel()
            } else {
                self.read(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count >= 2 else { return send(conn, status: "400 Bad Request", body: Data()) }
        let method = String(parts[0])
        guard method == "GET" || method == "HEAD" else {
            return send(conn, status: "405 Method Not Allowed", body: Data())
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }

        guard let file = resolve(String(parts[1])),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe)
        else { return send(conn, status: "404 Not Found", body: Data("not found".utf8)) }

        let type = Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        var extra = ["Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache"]

        // WebKit asks for audio and video in ranges, and will not play a
        // file whose server cannot answer one.
        if let range = headers["range"], let span = Self.parseRange(range, size: data.count) {
            let (from, to) = span
            extra["Content-Range"] = "bytes \(from)-\(to)/\(data.count)"
            let slice = data.subdata(in: from..<(to + 1))
            return send(conn, status: "206 Partial Content", body: method == "HEAD" ? Data() : slice, headers: extra, length: slice.count)
        }
        send(conn, status: "200 OK", body: method == "HEAD" ? Data() : data, headers: extra, length: data.count)
    }

    /// The file for a request path, never outside the root. Paths with no
    /// file behind them get index.html (the interface is one page).
    private func resolve(_ target: String) -> URL? {
        var path = String(target.split(separator: "?", maxSplits: 1).first ?? "/")
        path = path.removingPercentEncoding ?? path
        if path.contains("\0") { return nil }
        if path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/") || file.path == root.path else { return nil }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue {
            return file
        }
        if file.pathExtension.isEmpty { return root.appendingPathComponent("index.html") }
        return nil
    }

    private static func parseRange(_ header: String, size: Int) -> (Int, Int)? {
        guard size > 0, header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first ?? ""
        let ends = spec.split(separator: "-", omittingEmptySubsequences: false)
        guard ends.count == 2 else { return nil }
        if ends[0].isEmpty {
            guard let n = Int(ends[1]), n > 0 else { return nil }
            return (max(0, size - n), size - 1)
        }
        guard let from = Int(ends[0]), from < size else { return nil }
        let to = ends[1].isEmpty ? size - 1 : min(Int(ends[1]) ?? size - 1, size - 1)
        return from <= to ? (from, to) : nil
    }

    private func send(_ conn: NWConnection, status: String, body: Data, headers: [String: String] = [:], length: Int? = nil) {
        var head = "HTTP/1.1 \(status)\r\n"
        var all = headers
        all["Content-Length"] = String(length ?? body.count)
        all["Connection"] = "close"
        all["X-Content-Type-Options"] = "nosniff"
        for (k, v) in all { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "json": "application/json", "wasm": "application/wasm", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "ico": "image/x-icon", "woff": "font/woff", "woff2": "font/woff2",
        "ttf": "font/ttf", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
        "m4a": "audio/mp4", "mp4": "video/mp4", "webm": "video/webm", "txt": "text/plain; charset=utf-8",
        "onnx": "application/octet-stream", "bin": "application/octet-stream", "task": "application/octet-stream",
        "ppn": "application/octet-stream", "pv": "application/octet-stream", "data": "application/octet-stream",
    ]
}
