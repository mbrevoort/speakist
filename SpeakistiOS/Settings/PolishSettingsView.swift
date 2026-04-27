import SwiftUI

/// Per-user polish settings on iOS. Lets a signed-in user:
///   * Toggle the LLM polish pass on/off
///   * Edit the system prompt that drives the polish
///   * Reset back to the server-shipped default prompt
///
/// Source of truth for both fields is the server (`users.polish_enabled`,
/// `users.polish_system_prompt`); we PUT through `/api/me/polish` and
/// reflect the response back into the view. There is no local Preferences
/// cache on iOS — a fresh fetch on appear is cheap and avoids the
/// "stale local state vs. server" reconciliation the Mac has to do.
struct PolishSettingsView: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    /// Loaded server state. `nil` while the initial fetch is in flight or
    /// when the user is signed out (in which case the view shows a
    /// sign-in prompt instead of the editor).
    @State private var loaded: PolishState?
    @State private var draft: String = ""

    @State private var loading = true
    @State private var savingToggle = false
    @State private var savingMode = false
    @State private var savingPrompt = false
    @State private var lastError: String?
    @State private var lastSavedAt: Date?

    private var draftIsDirty: Bool {
        guard let loaded else { return false }
        return draft != loaded.systemPrompt
    }

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
            Text("Pipes the raw transcript through a small language model (Llama 3.1 8B on Groq) to add punctuation, capitalization, and clear grammar fixes. Adds about 200–500 ms of latency; cost absorbed.")
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
        }

        Section {
            // TextEditor on iOS doesn't have a built-in placeholder; we
            // overlay one when the draft is empty + polish is off, mirroring
            // the Mac's UX for "you need to enable polish first".
            TextEditor(text: $draft)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 220)
                .disabled(!loaded.enabled || savingPrompt)
                .scrollContentBackground(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))

            HStack(spacing: 12) {
                Button {
                    Task { await resetToDefault() }
                } label: {
                    Label("Reset to default", systemImage: "arrow.counterclockwise")
                }
                .disabled(!loaded.isCustom || savingPrompt)

                Spacer()

                Button {
                    Task { await savePrompt() }
                } label: {
                    Text(savingPrompt ? "Saving…" : "Save")
                }
                .buttonStyle(.borderedProminent)
                .tint(.speakistPeach)
                .disabled(
                    !loaded.enabled
                    || savingPrompt
                    || !draftIsDirty
                    || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        } header: {
            Text("System prompt")
        } footer: {
            footerView(loaded: loaded)
        }
    }

    @ViewBuilder
    private func footerView(loaded: PolishState) -> some View {
        if let err = lastError {
            Text(err)
                .font(.footnote)
                .foregroundStyle(.speakistCoral)
        } else if let savedAt = lastSavedAt {
            Text("Saved \(relative(savedAt)).")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if !loaded.isCustom {
            Text("Using the server default. Edit the text above and tap Save to override.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Text("Synced with your account. Updating from any device propagates everywhere.")
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

    private func savePrompt() async {
        guard let client = account.apiClient else { return }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        savingPrompt = true
        lastError = nil
        defer { savingPrompt = false }
        do {
            let resp = try await client.updatePolish(
                enabled: nil,
                systemPrompt: .value(trimmed)
            )
            apply(from: resp)
            lastSavedAt = Date()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func resetToDefault() async {
        guard let client = account.apiClient else { return }
        savingPrompt = true
        lastError = nil
        defer { savingPrompt = false }
        do {
            // `.null` clears `polish_system_prompt` server-side; the GET in
            // the response body returns the default in `system_prompt`, and
            // the editor seeds from that on apply().
            let resp = try await client.updatePolish(
                enabled: nil,
                systemPrompt: .null
            )
            apply(from: resp)
            lastSavedAt = Date()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Apply a `/api/me/polish` PUT response (or matching shape from
    /// /api/me's PolishInfo) to local state. Single funnel so every
    /// caller stays in sync as the response shape grows.
    private func apply(from resp: SpeakistAPIClient.PolishPrefsResponse) {
        let next = PolishState(
            enabled: resp.enabled,
            mode: resp.mode,
            systemPrompt: resp.systemPrompt,
            isCustom: resp.isCustom,
            defaultPrompt: resp.defaultPrompt
        )
        loaded = next
        // Only overwrite the editor when the server's effective prompt
        // changed and the local draft was clean; otherwise we'd stomp the
        // user's in-progress edit on every Save (which round-trips through
        // the server).
        if !draftIsDirtyVs(next) {
            draft = next.systemPrompt
        }
    }

    /// Same shape, used when hydrating from /api/me's PolishInfo (which
    /// is structurally identical to PolishPrefsResponse on the wire).
    private func apply(from polish: SpeakistAPIClient.MeResponse.PolishInfo) {
        let next = PolishState(
            enabled: polish.enabled,
            mode: polish.mode,
            systemPrompt: polish.systemPrompt,
            isCustom: polish.isCustom,
            defaultPrompt: polish.defaultPrompt
        )
        loaded = next
        if !draftIsDirtyVs(next) {
            draft = next.systemPrompt
        }
    }

    /// Is the editor's draft different from the given state's prompt? Used
    /// to decide whether to clobber the editor on a server response.
    private func draftIsDirtyVs(_ state: PolishState) -> Bool {
        draft != state.systemPrompt
    }

    private func relative(_ date: Date) -> String {
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .short
        return fmt.localizedString(for: date, relativeTo: Date())
    }

    /// Compact local mirror of the polish fields the Mac caches in
    /// Preferences. Plain struct keeps the view's state single-source.
    private struct PolishState: Equatable {
        let enabled: Bool
        let mode: SpeakistAPIClient.PolishMode
        let systemPrompt: String
        let isCustom: Bool
        let defaultPrompt: String
    }
}
