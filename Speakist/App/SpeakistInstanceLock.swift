import Darwin
import Foundation

/// A process-lifetime lock shared by every Speakist channel.
///
/// Stable, Beta, Dev, and Local deliberately use different bundle IDs so
/// their preferences and permissions stay isolated. macOS therefore allows
/// them to run side by side, even though they would then compete for the same
/// global shortcut and Core Audio daemon. `flock` gives those otherwise
/// separate apps one race-free ownership boundary. The kernel releases the
/// lock automatically if the owning process crashes or is force-quit.
final class SpeakistInstanceLock {
    struct Owner: Codable, Equatable, Sendable {
        let processID: Int32
        let bundleID: String
        let displayName: String
        let version: String
    }

    enum LockError: LocalizedError {
        case alreadyRunning(Owner?)
        case cannotCreateDirectory(String)
        case cannotOpen(String, Int32)
        case cannotLock(String, Int32)

        var errorDescription: String? {
            switch self {
            case let .alreadyRunning(owner):
                return "\(owner?.displayName ?? "Another copy of Speakist") is already running."
            case let .cannotCreateDirectory(path):
                return "Couldn't create the Speakist runtime directory at \(path)."
            case let .cannotOpen(path, code):
                return "Couldn't open the Speakist instance lock at \(path) (errno \(code))."
            case let .cannotLock(path, code):
                return "Couldn't acquire the Speakist instance lock at \(path) (errno \(code))."
            }
        }
    }

    static var currentOwner: Owner {
        Owner(
            processID: ProcessInfo.processInfo.processIdentifier,
            bundleID: AppIdentity.bundleID,
            displayName: AppIdentity.displayName,
            version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
    }

    static var defaultLockURL: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches
            .appendingPathComponent("com.brevoort-studio.speakist-runtime", isDirectory: true)
            .appendingPathComponent("active-instance.lock", isDirectory: false)
    }

    private var fileDescriptor: Int32

    init(lockURL: URL = SpeakistInstanceLock.defaultLockURL,
         owner: Owner = SpeakistInstanceLock.currentOwner) throws {
        let directory = lockURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            throw LockError.cannotCreateDirectory(directory.path)
        }

        let descriptor = Darwin.open(
            lockURL.path,
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw LockError.cannotOpen(lockURL.path, errno)
        }

        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockErrno = errno
            let existingOwner = Self.readOwner(from: lockURL)
            Darwin.close(descriptor)
            if lockErrno == EWOULDBLOCK || lockErrno == EAGAIN {
                throw LockError.alreadyRunning(existingOwner)
            }
            throw LockError.cannotLock(lockURL.path, lockErrno)
        }

        fileDescriptor = descriptor
        write(owner: owner)
    }

    deinit {
        release()
    }

    func release() {
        guard fileDescriptor >= 0 else { return }
        _ = flock(fileDescriptor, LOCK_UN)
        Darwin.close(fileDescriptor)
        fileDescriptor = -1
    }

    private func write(owner: Owner) {
        guard let data = try? JSONEncoder().encode(owner) else { return }
        _ = ftruncate(fileDescriptor, 0)
        _ = lseek(fileDescriptor, 0, SEEK_SET)
        data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            _ = Darwin.write(fileDescriptor, baseAddress, bytes.count)
        }
        _ = fsync(fileDescriptor)
    }

    private static func readOwner(from url: URL) -> Owner? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Owner.self, from: data)
    }
}
