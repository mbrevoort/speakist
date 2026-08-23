# Speakist documentation

Speakist is a macOS-first dictation product. New installs use local Parakeet transcription and guarded local cleanup by default; existing users retain their chosen engine. The web service provides the landing page, downloads, accounts, and optional Cloud transcription.

## Start here

- ../README.md — local setup, build, tests, and first run
- architecture.md — native and web boundaries, data flow, storage, and migration
- local-models.md — Parakeet and local cleanup implementation
- local-cleanup-lm-benchmark.md — tiny-model benchmark and safety gates
- cicd.md — development and production automation
- releasing.md — release checklist and rollback
- polish-prompt-mirror.md — Cloud prompt synchronization
- feedback-agent.md — opt-in quality-report workflow

## Environments

| Surface | Local | Development | Production |
| --- | --- | --- | --- |
| Web | localhost:3000 | speakist-dev.brevoortstudio.com | speakist.ai |
| Mac app | Speakist Local | Speakist Dev | Speakist, plus beta channel |
| Backend | local D1 | Cloudflare dev resources | Cloudflare production resources |

Local dictation does not require any backend. The local web stack is needed only for website, account, or Cloud-path development.
