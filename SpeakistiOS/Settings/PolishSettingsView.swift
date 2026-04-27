import SwiftUI

/// Per-user polish settings on iOS. Lets a signed-in user toggle the
/// post-transcription polish pass and pick a mode (Intuitive vs.
/// Prescriptive). The mode prompts themselves are super-admin-only and
/// configured at /admin/system on the web — iOS never shows or edits
/// the prompt text.
struct PolishSettingsView: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    /// Loaded server state. `nil` while the initial fetch is in flight or
    /// when the user is signed out (in which case the view shows a
    /// sign-in prompt instead of the controls).
    @State private var loaded: PolishState?

    @State private var loading = true
    @State private var savingToggle = false
    @State private var savingMode = false
    @State private var lastError: String?
    @State private var lastSavedAt: Date?

    var body: some View {
        Form {
            if !account.isSignedIn {
                signInPrompt
            } else if loading {
                Section { ProgressView().frame(maxWidth: .infinity, alignment: .center) }
            } else if let loaded {
                content(loaded: loaded)
            } else if let lastError {
                errorView(lastError)
            }
        }
        .navigationTitle("Polish")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    // MARK: - Sub-views

    private var signInPrompt: some View {
        Section {
            VStack(spacing: 12) {
                Image(systemName: "wand.and.sparkles")
                    .font(.system(size: 38))
                    .foregroundStyle(.secondary)
                Text("Sign in to manage Polish")
                    .font(.headline)
                Text("Polish settings are tied to your Speakist account.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .listRowBackground(Color.clear)
        }
    }

    @ViewBuilder
    private func content(loaded: PolishState) -> some View {
        Section {
            Toggle("Polish each transcription", isOn: Binding(
                get: { loaded.enabled },
                set: { saveToggle(to: $0) }
            ))
            .disabled(savingToggle)
            Text("Cleans up every transcription before it lands — adds punctuation, capitalization, and clear grammar fixes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } header: {
            Text("Post-transcription polish")
        }

        // Mode picker. Segmented control with a description that swaps
        // based on the selected mode. Visible always (even when polish
        // is off) so a user can configure their preferred mode before
        // flipping it on; disabled in that state to keep server calls
        // gated.
        Section {
            Picker("Mode", selection: Binding(
                get: { loaded.mode },
                set: { saveMode(to: $0) }
            )) {
                Text("Intuitive").tag(SpeakistAPIClient.PolishMode.intuitive)
                Text("Prescriptive").tag(SpeakistAPIClient.PolishMode.prescriptive)
            }
            .pickerStyle(.segmented)
            .disabled(!loaded.enabled || savingMode)

            Text(loaded.mode == .intuitive
                 ? "Tries to understand your intent and applies explicit self-corrections (\u{201C}I mean…\u{201D}, \u{201C}scratch that…\u{201D}). Best when you talk through a thought and want the polished result."
                 : "Conservative — only fixes punctuation, capitalization, and clear grammar. Never changes meaning or removes content. Best when you want verbatim with formatting.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } header: {
            Text("Mode")
        } footer: {
            footerView()
        }
    }

    @ViewBuilder
    private func footerView() -> some View {
        if let err = lastError {
            Text(err)
                .font(.footnote)
                .foregroundStyle(.speakistCoral)
        } else if let savedAt = lastSavedAt {
            Text("Saved \(relative(savedAt)).")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Text("Synced with your account. Changing here updates every device you're signed into.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        Section {
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.speakistCoral)
                Text("Couldn't load Polish settings")
                    .font(.headline)
                Text(message)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button("Retry") { Task { await load() } }
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
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
            // We piggyback on the existing /api/me payload (which carries
            // PolishInfo) instead of /api/me/polish so a single call also
            // refreshes balance + identity if anything else changed.
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
                lastSavedAt = Date()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func saveMode(to newValue: SpeakistAPIClient.PolishMode) {
        guard let client = account.apiClient else { return }
        guard newValue != loaded?.mode else { return }
        savingMode = true
        lastError = nil
        Task {
            defer { savingMode = false }
            do {
                let resp = try await client.updatePolish(
                    enabled: nil,
                    mode: newValue,
                    systemPrompt: nil
                )
                apply(from: resp)
                lastSavedAt = Date()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// Apply a `/api/me/polish` PUT response to local state.
    private func apply(from resp: SpeakistAPIClient.PolishPrefsResponse) {
        loaded = PolishState(enabled: resp.enabled, mode: resp.mode)
    }

    /// Same shape, used when hydrating from /api/me's PolishInfo.
    private func apply(from polish: SpeakistAPIClient.MeResponse.PolishInfo) {
        loaded = PolishState(enabled: polish.enabled, mode: polish.mode)
    }

    private func relative(_ date: Date) -> String {
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .short
        return fmt.localizedString(for: date, relativeTo: Date())
    }

    /// Local mirror of the two polish fields the user can change. The
    /// system prompt itself is super-admin-only and never displayed
    /// here, so the struct doesn't carry it.
    private struct PolishState: Equatable {
        let enabled: Bool
        let mode: SpeakistAPIClient.PolishMode
    }
}
