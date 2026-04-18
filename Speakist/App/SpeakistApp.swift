import SwiftUI

@main
struct SpeakistApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // No scenes — Settings, History, and Onboarding are each managed by
        // an NSWindowController in AppDelegate. For menu-bar-only
        // (LSUIElement) apps, SwiftUI's Settings scene dispatches through
        // `showSettingsWindow:` which isn't reliably handled; explicit
        // NSWindowControllers bring the windows forward deterministically.
        _EmptyScene()
    }
}

private struct _EmptyScene: Scene {
    var body: some Scene {
        // A single no-op settings scene so SwiftUI has something to return.
        // Never shown because AppDelegate uses an NSWindowController instead.
        Settings { EmptyView() }
    }
}
