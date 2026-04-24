import Foundation
import OSLog

#if canImport(AppKit)
import AppKit
#endif

/// A small façade over os.Logger + a rotating file sink at
/// `~/Library/Logs/{CFBundleName}/speakist.log`. Per-channel builds land
/// under distinct folders (`Speakist/`, `Speakist Dev/`, `Speakist Beta/`,
/// `Speakist Local/`) so you can grep logs from one channel without
/// cross-contamination.
final class Logger {
    static let shared = Logger()

    private let subsystem = AppIdentity.bundleID
    private let osLog: os.Logger
    private let queue = DispatchQueue(label: "\(AppIdentity.bundleID).logger", qos: .utility)
    private let fileManager = FileManager.default
    private lazy var logDirectory: URL = {
        let base = fileManager.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Logs").appendingPathComponent(AppIdentity.displayName)
    }()
    private lazy var logFile: URL = logDirectory.appendingPathComponent("speakist.log")

    private init() {
        osLog = os.Logger(subsystem: subsystem, category: "app")
    }

    func bootstrap() {
        try? fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        if !fileManager.fileExists(atPath: logFile.path) {
            fileManager.createFile(atPath: logFile.path, contents: nil)
        }
        rotateIfNeeded()
        info("Speakist booting up, version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?")")
    }

    func info(_ message: String) {
        osLog.info("\(message, privacy: .public)")
        append(level: "INFO", message: message)
    }

    func warn(_ message: String) {
        osLog.warning("\(message, privacy: .public)")
        append(level: "WARN", message: message)
    }

    func error(_ message: String) {
        osLog.error("\(message, privacy: .public)")
        append(level: "ERROR", message: message)
    }

    func debug(_ message: String) {
        osLog.debug("\(message, privacy: .public)")
        #if DEBUG
        append(level: "DEBUG", message: message)
        #endif
    }

    #if canImport(AppKit)
    func revealInFinder() {
        NSWorkspace.shared.selectFile(logFile.path, inFileViewerRootedAtPath: logDirectory.path)
    }
    #endif

    // MARK: - File sink

    private func append(level: String, message: String) {
        queue.async { [logFile] in
            let stamp = ISO8601DateFormatter().string(from: Date())
            let line = "\(stamp) \(level) \(message)\n"
            guard let data = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: logFile) {
                defer { try? handle.close() }
                try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            }
        }
    }

    private func rotateIfNeeded() {
        let fiveMB: UInt64 = 5 * 1024 * 1024
        guard let attrs = try? fileManager.attributesOfItem(atPath: logFile.path),
              let size = (attrs[.size] as? NSNumber)?.uint64Value,
              size >= fiveMB else { return }
        let candidates = [
            logDirectory.appendingPathComponent("speakist.log.3"),
            logDirectory.appendingPathComponent("speakist.log.2"),
            logDirectory.appendingPathComponent("speakist.log.1")
        ]
        if fileManager.fileExists(atPath: candidates[0].path) { try? fileManager.removeItem(at: candidates[0]) }
        try? fileManager.moveItem(at: candidates[1], to: candidates[0])
        try? fileManager.moveItem(at: candidates[2], to: candidates[1])
        try? fileManager.moveItem(at: logFile, to: candidates[2])
        fileManager.createFile(atPath: logFile.path, contents: nil)
    }
}
