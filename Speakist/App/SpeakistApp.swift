import SwiftUI

@main
struct SpeakistApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // SwiftUI's `App.body` requires a `Scene`, but every Speakist
        // surface (main window, onboarding, HUD) is managed by an
        // explicit `NSWindowController` in `AppDelegate`. The
        // `Settings { EmptyView() }` scene satisfies the compile-time
        // requirement; the `.commands` block clears the
        // automatically-injected `.appSettings` command so SwiftUI
        // doesn't add its own "Settings…" menu item that would open
        // the framework's empty Settings window. The top menu bar
        // itself is installed from `AppDelegate.installMainMenu()`
        // (deferred + reinstalled on every activation, to survive
        // SwiftUI's own menu rebuilds).
        Settings { EmptyView() }
            .commands {
                CommandGroup(replacing: .appSettings) { }
            }
    }
}
