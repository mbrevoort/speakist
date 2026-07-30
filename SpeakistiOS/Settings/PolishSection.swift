import SwiftUI

/// Inline Polish settings, designed to slot directly into the Home
/// list (`Form`/`List` of sections). Renders one Section holding the
/// enable toggle, so the whole Polish surface lives on the main screen
/// instead of behind a NavigationLink. Returns `EmptyView()` when
/// signed out so the Section disappears entirely instead of showing
/// a sign-in prompt that conflicts with the existing Account row.
///
/// Polish is single-behavior now (the intuitive/prescriptive mode split
/// was retired — the server always uses the intuitive prompt), so the
/// only user choice is on/off. The system prompt itself is
/// super-admin-only (configured at /admin/system on web).
struct PolishSection: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    /// Loaded server state. `nil` while the initial fetch is in flight,
    /// or when the user is signed out (in which case body returns
    /// EmptyView and the section disappears entirely).
    @State private var loaded: PolishState?

    @State private var loading = true
    @State private var savingToggle = false
    @State private var lastError: String?

    var body: some View {
        if !account.isSignedIn {
            // Signed out → no Polish section on Home. The Account row
            // already prompts for sign-in; doubling that here would
            // just be visual noise.
            EmptyView()
        } else if loading {
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
            } header: {
                Text("Polish")
            }
            .task { await load() }
        } else if let loaded {
            content(loaded: loaded)
        } else if let lastError {
            errorSection(lastError)
        }
    }

    // MARK: - Sub-views

    @ViewBuilder
    private func content(loaded: PolishState) -> some View {
        Section {
            Toggle("Polish each transcription", isOn: Binding(
                get: { loaded.enabled },
                set: { saveToggle(to: $0) }
            ))
            .disabled(savingToggle)
        } header: {
            Text("Polish")
        } footer: {
            if let err = lastError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.speakistCoral)
            } else {
                Text("A second pass that applies your spoken self-corrections (\u{201C}I mean…\u{201D}, \u{201C}scratch that…\u{201D}), removes false starts, and breaks long dictations into paragraphs. Adds a moment of processing after each dictation.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func errorSection(_ message: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Couldn't load Polish settings")
                    .font(.subheadline.weight(.medium))
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Retry") { Task { await load() } }
                    .buttonStyle(.bordered)
            }
            .padding(.vertical, 4)
        } header: {
            Text("Polish")
        }
    }

    // MARK: - Actions

    private func load() async {
        guard let client = account.apiClient, account.isSignedIn else {
            loading = false
            return
        }
        loading = true
        lastError = nil
        defer { loading = false }
        do {
            // Piggyback on /api/me so a single call also refreshes
            // identity / balance state if anything else changed since
            // last open.
            let me = try await client.fetchMe()
            guard let polish = me.polish else {
                lastError = "Server didn't return polish settings."
                return
            }
            apply(from: polish)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func saveToggle(to newValue: Bool) {
        guard let client = account.apiClient else { return }
        savingToggle = true
        lastError = nil
        Task {
            defer { savingToggle = false }
            do {
                let resp = try await client.updatePolish(
                    enabled: newValue,
                    systemPrompt: nil
                )
                apply(from: resp)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func apply(from resp: SpeakistAPIClient.PolishPrefsResponse) {
        loaded = PolishState(enabled: resp.enabled, mode: resp.mode)
    }

    private func apply(from polish: SpeakistAPIClient.MeResponse.PolishInfo) {
        loaded = PolishState(enabled: polish.enabled, mode: polish.mode)
    }

    /// Local mirror of the two polish fields the user can change. The
    /// system prompt itself is super-admin-only and never displayed
    /// here.
    private struct PolishState: Equatable {
        let enabled: Bool
        let mode: SpeakistAPIClient.PolishMode
    }
}
