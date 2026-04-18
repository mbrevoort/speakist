import Foundation
import Sparkle
import AppKit

@MainActor
final class UpdaterController: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController?

    func bootstrap() {
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil)
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}
