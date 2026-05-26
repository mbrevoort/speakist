# Polish-fixture proposer agent — setup

The "Report bad transcription" feature gives users a way to share STT
mistakes + their corrections back to Speakist. The corpus that's
piling up at `/admin/feedback` is the input to a feedback loop:

1. **Agent runs on a schedule** (cron, GitHub Action, your laptop)
2. **Pulls new feedback** since the last run via the Speakist API
3. **Clones the speakist repo** + reads `web/src/lib/transcription/polish.ts`
   and `polish-fixtures.ts`
4. **Iterates** prompt variations against the bench, scoring each
5. **Opens a PR** with a verifiable improvement
6. **Marks the source feedback rows** as `proposed` so they don't
   re-trigger next run

This doc walks through the auth + API surface the agent needs.
The agent itself runs **outside** Speakist — its model choice,
hosting, scheduling, and GitHub credentials are independent from
Speakist's deployment.

## Auth: service tokens

The agent isn't a browser, so cookie-based Auth.js doesn't work. Mint a
**service token** at `/admin/tokens`:

1. Go to `/admin/tokens` (super-admin only)
2. Click **Create token** → label it (e.g.
   `polish-fixture-proposer (mike-laptop)`) and pick scopes:
    - **`feedback:read`** — list, get detail, download audio (always required)
    - **`feedback:triage`** — update status / add resolution / delete (required for the agent to mark rows proposed)
3. Hit Create → copy the plaintext value shown ONCE (`ssat_…`).
   The DB only ever stores the SHA-256 hash; once you dismiss the
   reveal panel the value is unrecoverable.
4. Configure your agent with that value in whatever secret store it
   reads (1Password CLI, env var, Vault, etc.).

You can mint multiple tokens (e.g. one per agent host, one read-only
for diagnostics). Revoke any of them with one click; their
`last_used_at` column makes dead tokens easy to spot.

## Two ways to talk to Speakist

### Option 1 — Plain HTTP (simplest)

Hit the existing REST endpoints with the bearer:

```bash
TOKEN=ssat_...

# List new feedback (defaults to status=new, limit=50)
curl -H "Authorization: Bearer $TOKEN" \
  https://speakist.ai/api/admin/feedback

# Filter / advance a cursor
curl -H "Authorization: Bearer $TOKEN" \
  'https://speakist.ai/api/admin/feedback?status=new&limit=200'

# Full detail for one row
curl -H "Authorization: Bearer $TOKEN" \
  https://speakist.ai/api/admin/feedback/$ID

# Download audio (when shared)
curl -H "Authorization: Bearer $TOKEN" \
  https://speakist.ai/api/admin/feedback/$ID/audio -o audio.wav

# Move to proposed once you've opened a PR
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"proposed","resolution":"https://github.com/mbrevoort/speakist/pull/N"}' \
  https://speakist.ai/api/admin/feedback/$ID
```

### Option 2 — MCP (typed tool surface)

Speakist exposes an MCP server at `https://speakist.ai/api/mcp`.
Configure your MCP-aware agent client (Claude Code, Claude Desktop,
custom SDK) with that URL + your service token as a bearer.

For Claude Code, add to `~/.claude.json` or your project's
`.claude/mcp.json`:

```json
{
  "mcpServers": {
    "speakist-feedback": {
      "type": "http",
      "url": "https://speakist.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer ssat_..."
      }
    }
  }
}
```

The agent will see five tools (filtered by your token's scopes —
read-only tokens hide the triage tools):

| Tool | Scope | Purpose |
|---|---|---|
| `list_feedback` | `feedback:read` | Newest-first list, optional `status` + `since` cursor |
| `get_feedback` | `feedback:read` | Full row (raw / polished / expected / metadata) |
| `get_feedback_audio` | `feedback:read` | Base64 audio when the user shared it |
| `mark_feedback_proposed` | `feedback:triage` | Move to `proposed` + record PR URL |
| `mark_feedback_resolution` | `feedback:triage` | General-purpose status / resolution update |

## Suggested agent workflow

```
loop:
  rows = list_feedback({ status: "new", since: <last-cursor> })
  if rows.empty: exit
  for row in rows:
    detail = get_feedback({ id: row.id })
    fixture_seed = build_fixture(detail.raw_text, detail.expected_text)
    candidate_prompts = generate_variations(current_prompt, detail)
    for prompt in candidate_prompts:
      result = run_pnpm_bench_polish(prompt, fixtures + [fixture_seed])
      if result.passes_new and not result.regresses_old:
        winners.add(prompt)
  if winners.empty: exit
  best = pick_lowest_diff(winners)
  branch = git_checkout_b("agent/polish-...")
  apply(best)
  pr = gh_pr_create(...)
  for row in rows:
    mark_feedback_proposed({ id: row.id, pr_url: pr.url, summary: ... })
  store_cursor(now)
```

The bench script lives at `web/scripts/bench-polish.ts` and runs in
the agent's worktree of the speakist repo — no Speakist API needed
for that part.

## Notes

- **Audio is rarely needed.** Polish-prompt iteration is text-only
  (raw → polished → expected). `get_feedback_audio` exists for STT
  diagnostics, not for the polish loop.
- **The `proposed` status is the agent's contract.** Don't manually
  set it on the admin page — that's the signal "an agent has a PR
  open for this." Use `reviewed` / `resolved` / `dismissed` for
  human-driven triage.
- **Idempotency.** Re-marking a row as proposed just refreshes its
  resolution string. Listing with a `since` cursor keeps the agent
  from re-touching rows it's already handled.
- **Org opt-out.** Workspace owners can disable the Report feature
  for their workspace at `/dashboard/settings`; rows from those
  workspaces simply stop appearing. The agent doesn't need to
  filter for this — feedback that arrives in the corpus is
  consent-given by definition.
