import Foundation
import Network

/// The background link: one quiet WebSocket to the bridge's /device endpoint,
/// held open so JARVIS can reach this Mac at any time — the same link, and the
/// same messages, as the Android app's DeviceLinkService.
///
///   bridge → Mac   { type: "device_call", id, tool, args }
///   Mac → bridge   { type: "device_hello", capabilities, model, macos }
///                  { type: "device_result", id, ok, text?, json?, data?, mimeType?, error? }
///
/// Reconnects by itself: at once when the network comes back or the Mac
/// wakes, otherwise with backoff up to a minute — Tailscale takes a moment to
/// come back after each change.
final class DeviceLink: NSObject, URLSessionWebSocketDelegate {
    enum State: Equatable {
        case off
        case connecting
        case connected
        case failed(String)
    }

    /// Called on the main queue whenever the state changes.
    var onChange: ((State) -> Void)?
    private(set) var state: State = .off {
        didSet {
            let s = state
            DispatchQueue.main.async { self.onChange?(s) }
        }
    }

    private let queue = DispatchQueue(label: "app.jarvis.mac.link")
    private let work = DispatchQueue(label: "app.jarvis.mac.commands", attributes: .concurrent)
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        let q = OperationQueue()
        q.underlyingQueue = queue
        q.maxConcurrentOperationCount = 1
        return URLSession(configuration: config, delegate: self, delegateQueue: q)
    }()

    private let commands = Commands()
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var token = ""
    private var attempt = 0
    private var retry: DispatchWorkItem?
    private var pinger: DispatchSourceTimer?
    private let path = NWPathMonitor()

    override init() {
        super.init()
        path.pathUpdateHandler = { [weak self] p in
            guard let self, p.status == .satisfied else { return }
            self.queue.async {
                if self.url != nil, self.state != .connected { self.connectNow() }
            }
        }
        path.start(queue: queue)
    }

    /// Link to `url` (…/device) with `token`. Replaces any earlier link.
    func start(url: URL, token: String) {
        queue.async {
            self.url = url
            self.token = token
            self.attempt = 0
            self.connectNow()
        }
    }

    func stop() {
        queue.async {
            self.url = nil
            self.retry?.cancel()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.stopPinging()
            self.state = .off
        }
    }

    /// After a wake from sleep the old socket is usually dead without knowing it.
    func reconnect() {
        queue.async {
            guard self.url != nil else { return }
            self.attempt = 0
            self.connectNow()
        }
    }

    // MARK: - connecting (all on `queue`)

    private func connectNow() {
        retry?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        stopPinging()
        guard let url else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("jarvis.v1", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let t = session.webSocketTask(with: req)
        t.maximumMessageSize = 32 * 1024 * 1024
        task = t
        state = .connecting
        t.resume()
        receive(on: t)
    }

    private func scheduleRetry(_ why: String) {
        guard url != nil else { return }
        state = .failed(why)
        let delay = min(60.0, pow(2.0, Double(min(attempt, 6))))
        attempt += 1
        let item = DispatchWorkItem { [weak self] in self?.connectNow() }
        retry = item
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func startPinging(_ t: URLSessionWebSocketTask) {
        stopPinging()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 45, repeating: 45)
        timer.setEventHandler { [weak self, weak t] in
            t?.sendPing { error in
                guard let self, error != nil else { return }
                self.queue.async {
                    if t === self.task { self.scheduleRetry("sem resposta do Jarvis") }
                }
            }
        }
        timer.resume()
        pinger = timer
    }

    private func stopPinging() {
        pinger?.cancel()
        pinger = nil
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        guard webSocketTask === task else { return }
        attempt = 0
        state = .connected
        startPinging(webSocketTask)
        let hello: [String: Any] = [
            "type": "device_hello",
            "capabilities": Commands.capabilities,
            "model": SystemInfo.model(),
            "macos": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        send(hello, on: webSocketTask)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        // 4000: replaced by a newer link from this same Mac — not a failure.
        scheduleRetry(closeCode.rawValue == 4000 ? "" : "conexão encerrada")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let why: String
        switch code {
        case 401, 403: why = "o Jarvis recusou o token — pareie de novo"
        case 0: why = url?.host == "127.0.0.1" ? "a ponte local não está rodando" : "sem acesso ao PC (Tailscale ligado?)"
        default: why = "o Jarvis respondeu \(code)"
        }
        scheduleRetry(why)
    }

    // MARK: - messages

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard t === self.task else { return }
                switch result {
                case .failure:
                    // didCompleteWithError follows with the reason; nothing to add here.
                    return
                case .success(let message):
                    switch message {
                    case .string(let text): self.handle(text, on: t)
                    case .data(let data): self.handle(String(decoding: data, as: UTF8.self), on: t)
                    @unknown default: break
                    }
                    self.receive(on: t)
                }
            }
        }
    }

    private func handle(_ text: String, on t: URLSessionWebSocketTask) {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              obj["type"] as? String == "device_call",
              let id = obj["id"] as? String,
              let tool = obj["tool"] as? String
        else { return }
        let args = obj["args"] as? [String: Any] ?? [:]
        // Off the socket's queue: some commands wait (a click on "Permitir",
        // a Shortcut running), and the next command must not queue behind them.
        work.async { [weak self] in
            guard let self else { return }
            var reply = self.commands.run(tool, args)
            reply["type"] = "device_result"
            reply["id"] = id
            self.queue.async { self.send(reply, on: t) }
        }
    }

    private func send(_ obj: [String: Any], on t: URLSessionWebSocketTask) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8)
        else { return }
        t.send(.string(text)) { _ in }
    }
}
