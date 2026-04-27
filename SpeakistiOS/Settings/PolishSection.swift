import SwiftUI

/// Inline Polish settings, designed to slot directly into the Home
/// list (`Form`/`List` of sections). Renders one Section that holds
/// the enable toggle and — when enabled — a mode segmented picker
/// underneath, so the whole Polish surface lives on the main screen
/// instead of behind a NavigationLink. Returns `EmptyView()` when
/// signed out so the Section disappears entirely instead of showing
/// a sign-in prompt that conflicts with the existing Account row.
///
/// The system prompt itself is super-admin-only (configured at
/// /admin/system on web). End users only choose enable + mode.
struct PolishSection: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    /// Loaded server state. `nil` while the initial fetch is in flight,
    /// or when the user is signed out (in which case body returns
    /// EmptyView and the section disappears entirely).
    @State private var loaded: PolishState?

    @State private var loading = true
    @State private var savingToggle = false
    @State private var savingMode = false
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

            // Mode picker is always visible so the user can configure
            // their preferred mode before turning polish on. Disabled
            // (greyed out) when the toggle is off so server calls
            // don't fire on a state nobody asked for.
            VStack(alignment: .leading, spacing: 8) {
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
            }
            .padding(.vertical, 4)
        } header: {
            Text("Polish")
        } footer: {
            if let err = lastError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.speakistCoral)
            } else {
                Text("Cleans up every transcription before it lands — adds punctuation, capitalization, and clear grammar fixes.")
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
