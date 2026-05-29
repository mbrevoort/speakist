# Active-learning loop — agent setup

"Report bad transcription" gives users a way to share STT mistakes +
their corrections back to Speakist. The corpus that accumulates at
`/admin/feedback` is the input to a feedback loop:

1. **Agent runs on a schedule** (cron, GitHub Action, your laptop).
2. **Pulls new feedback** since the last run via MCP.
3. **Reads the live polish prompt** + the regression fixtures.
4. **Iterates** prompt variations against the bench, scoring each.
5. **Proposes a winner** to the prompt-versioning system, with bench
   results attached.
6. **Marks the source feedback rows** as `proposed` so they don't
   re-trigger the next run.

The agent runs **outside** Speakist — its model choice, hosting,
scheduling, and prompts are independent from Speakist's deployment.
This doc covers the auth + tool surface it needs.

## Auth: service tokens

The agent isn't a browser, so cookie-based Auth.js doesn't work. Mint
a **service token** at `/admin/tokens`:

1. Go to `/admin/tokens` (super-admin only).
2. Click **Create token** → label it (e.g. `polish-fixture-proposer`)
   and pick scopes:
    - **`feedback:read`** — list, get detail, download audio.
    - **`feedback:triage`** — update status / add resolution.
    - **`prompts:read`** — get the active polish prompt, list/inspect
      version history.
    - **`prompts:write`** — propose a new active version. Required for
      the agent to actually promote a candidate.
3. Hit Create → copy the plaintext value shown ONCE (`ssat_…`). The
   DB only ever stores the SHA-256 hash; once you dismiss the reveal
   panel the value is unrecoverable.
4. Configure your agent with that value in whatever secret store it
   reads.

Multiple tokens per agent host are fine — revoke any of them with one
click; `last_used_at` makes dead tokens easy to spot.

**Rollback is intentionally not in the MCP surface.** The agent can
propose; only a human at `/admin/polish-prompts` can roll back. The
agent never undoes a human decision.

## MCP — the typed tool surface

Speakist exposes an MCP server at `<your-deployment>/api/mcp`.
Configure your MCP client (Claude Code, Claude Desktop, custom SDK)
with that URL and your service token as a bearer.

For Claude Code, add to `~/.claude.json` or your project's
`.claude/mcp.json`:

```json
{
  "mcpServers": {
    "speakist": {
      "type": "http",
      "url": "https://<your-deployment>/api/mcp",
      "headers": {
        "Authorization": "Bearer ssat_..."
      }
    }
  }
}
```

The agent will see these tools (filtered by your token's scopes —
narrower tokens see fewer tools):

### Feedback (input — the corpus the agent learns from)

| Tool | Scope | Purpose |
|---|---|---|
| `list_feedback` | `feedback:read` | Newest-first list, optional `status` + `since` cursor. |
| `get_feedback` | `feedback:read` | Full row: raw STT + polished delivered + user-expected text, plus the request-context snapshot from the original `/api/transcribe` call. |
| `get_feedback_audio` | `feedback:read` | Base64 audio when the user shared it. Rarely needed for polish iteration (text-only). |
| `mark_feedback_proposed` | `feedback:triage` | Move to `proposed` + record PR URL or version ID. |
| `mark_feedback_resolution` | `feedback:triage` | General-purpose status / resolution update. |

### Polish prompts (output — what the agent iterates on)

| Tool | Scope | Purpose |
|---|---|---|
| `get_active_polish_prompt` | `prompts:read` | The body `/api/transcribe` is serving right now for a mode, plus version + bench score. |
| `list_polish_prompt_versions` | `prompts:read` | History, newest-first. Body omitted for compactness; call get_polish_prompt_version for the text. |
| `get_polish_prompt_version` | `prompts:read` | Full body of a specific version (by `(mode, version)` or `id`). Use to diff against history. |
| `propose_polish_prompt` | `prompts:write` | Promote a candidate body to active for a mode. Creates a new row with `source='agent'` attributed to the calling token. Requires `notes` (the why), accepts optional `bench_score` and `bench_results`. Slack fires automatically. |

## Suggested agent workflow

```
loop:
  feedback = list_feedback({ status: "new", since: <last-cursor> })
  if feedback.empty: exit

  active = get_active_polish_prompt({ mode })
  current_body = active.body
  current_score = active.bench_score    # the bar to beat

  # Build new fixtures from this batch of feedback rows.
  for row in feedback:
    detail = get_feedback({ id: row.id })
    fixture_seed = build_fixture(detail.raw_text, detail.expected_text)

  # Try N candidate prompt variations.
  candidates = generate_variations(current_body, feedback)
  results = []
  for candidate in candidates:
    score, per_fixture = run_pnpm_bench_polish(candidate, all_fixtures)
    if score > current_score and not regresses_baseline(per_fixture):
      results.append({ body: candidate, score, per_fixture })

  if results.empty:
    # No candidate beat the bar — mark the feedback as reviewed so we
    # don't re-attempt next run.
    for row in feedback:
      mark_feedback_resolution({ id: row.id, status: "reviewed",
                                 resolution: "candidates did not improve bench" })
    exit

  best = pick_highest_score(results)
  promoted = propose_polish_prompt({
    mode,
    body: best.body,
    notes: f"Addresses {len(feedback)} feedback items "
           f"(IDs: {ids}). Bench: {best.score:.3f} vs current {current_score:.3f}.",
    bench_score: best.score,
    bench_results: best.per_fixture,
  })

  for row in feedback:
    mark_feedback_proposed({
      id: row.id,
      pr_url: f"https://<deployment>/admin/polish-prompts",
      summary: f"Promoted to v{promoted.version} (bench {best.score:.3f})",
    })
  store_cursor(now)
```

The bench script lives at `web/scripts/bench-polish.ts` and runs
locally in the agent's worktree — no Speakist API needed for that
part. Pass `--tier all` (or specific fixtures) when validating a
candidate. The baseline-only run (`--tier baseline`) is for CI; the
agent's job is to keep the advanced tier passing.

## What the Slack notification carries

Every successful `propose_polish_prompt` call fires the Slack
`prompt_update` channel (configured at `/admin/system` → Slack
notifications). The message shows:

- Mode + new version number (e.g. "intuitive v12")
- Source badge: `agent`
- Actor: the token's label
- Bench score with delta vs the previous active (e.g. `bench 0.95
  (+0.02)`)
- The notes the agent supplied
- An "Open in admin" button → `/admin/polish-prompts`

A regression (`delta < 0`) gets a `:warning:` header emoji so a human
can review and roll back if needed. The agent itself can't roll
back — `rollback_polish_prompt` is not in the MCP surface by design.

## Notes

- **Audio is rarely needed.** Polish-prompt iteration is text-only.
  `get_feedback_audio` exists for STT diagnostics, not for the polish
  loop.
- **The `proposed` status is the agent's contract.** Don't manually
  set it on the admin page — that's the signal "an agent has promoted
  a version covering this feedback." Use `reviewed` / `resolved` /
  `dismissed` for human-driven triage.
- **Idempotency.** Re-marking a row as proposed just refreshes its
  resolution string. Listing with a `since` cursor keeps the agent
  from re-touching rows it's already handled.
- **Org opt-out.** Workspace owners can disable the Report feature
  for their workspace at `/dashboard/settings`; rows from those
  workspaces simply stop appearing.
- **Plain HTTP works too.** Both the feedback and prompts surfaces
  have REST equivalents under `/api/admin/feedback*` and
  `/api/admin/polish-prompts*` — the MCP route is just JSON-RPC
  glue over the same logic. Use HTTP if your agent doesn't speak
  MCP.
