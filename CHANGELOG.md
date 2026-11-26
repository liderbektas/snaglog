# Changelog

All notable changes to snaglog are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

First development version; not yet published.

### Added

- `log-snag` skill: drafts a snag report when a skill does not work as described, masks secrets and personal data, shows the exact text, and files it — or comments on a similar open issue — in the skill's own repo only after approval; otherwise keeps it in `~/.snaglog/snags.jsonl`. Never files in unattended runs.
- `fix-snags` skill for skill owners: fetches and parses open snags, pre-groups them by failure signature with local telemetry as evidence, adds eval cases that reproduce each snag, and opens an approved pull request with `Fixes #N` lines. Treats issue text as untrusted and never merges.
- `snaglog init`: wires every skill in a repo (`metadata.snaglog-repo`, snag reminder, labels, bundled skills, inactive eval skeletons, `evals/results/` ignored), plan first, idempotent.
- `snaglog connect` / `disconnect` for Claude Code and Codex: shows and backs up every change, turns all prompt and content logging off, installs a local skill-name hook for Claude Code, and restores the original file exactly.
- Local OTLP/HTTP JSON receiver with Claude Code and Codex adapters; stores only allow-listed per-skill events.
- `snaglog collect`: snag issues (read-only) and results of `claude plugin eval`.
- `snaglog eval`: runs Claude Code's official `claude plugin eval` for changed skills (or one, or all) after showing an estimate and a hard cost ceiling, and records results with the skill's commit.
- `snaglog dashboard`: local dashboard with overview, skill detail, before/after, unsent reports and connections pages; light and dark themes; `--demo` mode.

### Changed after the end-to-end trial

See [docs/E2E-TRIAL.md](docs/E2E-TRIAL.md): stable node path and self-updating hook, plugin namespaces dropped from skill names, skill windows no longer closed on `assistant_response`, `snaglog eval --trust-plugin` with its own confirmation, valid `match: not_contains` in the eval-case template, honest small-sample verdicts, `SNAGLOG_DEBUG_EVENTS`.

### Known limitations

- The end-to-end trial covered Claude Code only.
- Codex adapter not yet verified with a live capture.
- OTLP protobuf is not accepted.
- Team mode is not implemented.
