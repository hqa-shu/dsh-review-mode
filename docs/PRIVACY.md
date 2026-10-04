# Data handling and trust boundaries

## What the host reads

- Local DSH conversation records under `~/.dsh/sessions`.
- Local Codex rollouts under `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Codex title/project indexes, including `session_index.jsonl` and `.codex-global-state.json`.
- Code timestamps and hashes for runtime diagnostics.

Discovery can inspect directories and metadata; selecting a target prepares conversation evidence for review. The turn-review path can include recent Codex evidence when `codex` is enabled.

## Where evidence goes

The independent reviewer receives a prompt containing selected evidence. The host's configured model provider processes that prompt. With a remote model, conversation excerpts and tool evidence are transmitted to that provider. This plugin is not a local-inference guarantee.

## What is written

The host writes probe caches under `~/.dsh/review-mode`, review state/messages through Harness session persistence, and diagnostic traces under `/tmp/dsh-review-*`. Those files can contain identifiers, paths or excerpts. Treat them as private. The repository ignores local logs, evidence outputs and environment files.

## Limits

The reviewer has no tools, but the host plugin runs with host file access. Evidence budgeting reduces size, not sensitivity. Automatic secret redaction is not guaranteed, and adversarial content in conversation records can affect model output. Review advice is fallible and requires human judgment.

Use synthetic conversations first. Before sharing a report, remove credentials, personal messages, private identifiers and absolute personal paths. Do not upload your `.dsh`, `.codex`, cache or credential directories.
