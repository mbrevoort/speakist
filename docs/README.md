# Speakist documentation

Speakist is a local-only macOS dictation product. Current releases use on-device speech recognition and guarded language-model cleanup. The web service provides the landing page and downloads; legacy account and cloud routes remain temporarily for older binaries.

## Start here

- ../README.md — local setup, build, tests, and first run
- architecture.md — native and web boundaries, data flow, storage, and migration
- local-models.md — Parakeet and local cleanup implementation
- local-cleanup-lm-benchmark.md — tiny-model benchmark and safety gates
- cicd.md — development and production automation
- releasing.md — release checklist and rollback
- polish-prompt-mirror.md — legacy cloud prompt synchronization
- feedback-agent.md — legacy opt-in quality-report workflow

## Environments

| Surface | Local | Development | Production |
| --- | --- | --- | --- |
| Web | localhost:3000 | speakist-dev.brevoortstudio.com | speakist.ai |
| Mac app | Speakist Local | Speakist Dev | Speakist, plus beta channel |
| Backend | local D1 | Cloudflare dev resources | Cloudflare production resources |

Dictation does not require any backend. The local web stack is needed for website work or explicit legacy-backend maintenance.
