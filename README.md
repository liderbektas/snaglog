# snaglog

> Status: early development (milestone M0). Nothing here is usable yet.

snaglog gives a team a **measure → report → fix → verify** loop for its own agent skills (`SKILL.md`):

1. **Report** — when an agent hits a snag in a skill, the `log-snag` skill drafts a sanitized report, shows it to the user, and only on approval files (or appends to) an issue in the skill's source repo.
2. **Fix** — the `fix-snags` skill helps the skill owner group reports by root cause, propose a fix as a pull request, and turn every fix into an eval case.
3. **Telemetry** — a local OpenTelemetry (OTLP/HTTP) receiver turns events from Claude Code, Codex and others into per-skill metrics. Prompt text and tool output are never stored.
4. **Dashboard** — a local web page (`127.0.0.1` only) with usage, reliability, snag and eval metrics per skill, plus before/after comparisons for every `SKILL.md` change.

Evals run through [caliper](https://pypi.org/project/caliper-eval/); snaglog does not ship its own eval runner.

## Planned commands

```bash
snaglog init --repo owner/private-skills   # wire every skill in a repo to snaglog
snaglog connect <agent>                    # route an agent's telemetry to snaglog
snaglog disconnect <agent>                 # undo that
snaglog collect                            # collect snag and eval data
snaglog eval <skill> [--ablate]            # run caliper evals and record the result
snaglog dashboard                          # receiver + dashboard on http://127.0.0.1:4747
```

## Design notes

- [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md) — existing projects and how snaglog relates to them.
- [docs/AGENT-ADAPTERS.md](docs/AGENT-ADAPTERS.md) — how each agent's telemetry looks and how skill invocations are recognized.

## License

MIT
