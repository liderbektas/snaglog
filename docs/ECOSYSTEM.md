# Ecosystem

The standards, official agent features and tools snaglog builds on, and the rules for adding anything else. Researched 2026-11-26 from official documentation and source code.

## Trust policy

Security is the first requirement: snaglog handles private skill repositories, agent telemetry and issue text. Therefore:

1. **No data leaves the machine except what the user explicitly approves** (a snag report shown in full before filing). The receiver and dashboard bind `127.0.0.1` only; snaglog sends no telemetry; any child process snaglog starts runs with its telemetry and any report publishing switched off.
2. **snaglog builds only on official, built-in agent features** — the agents' own OpenTelemetry export, hook and eval systems — and on the `gh` CLI. Community plugins, hook bridges and third-party collectors are not used, even where they would add agent coverage.
3. **A third-party project may become a dependency only if it is established:** an OSI license file in the repository, an organisation or several active maintainers, real adoption, a stable release line, and no data sent anywhere by default (or a documented, enforceable off switch).
4. **No third-party code is copied.** Secret-masking patterns follow the public rule set of [gitleaks](https://github.com/gitleaks/gitleaks), an established secret scanner, and are re-implemented and tested in snaglog.

## Skill metadata: `metadata.snaglog-repo`

The [Agent Skills specification](https://agentskills.io/specification) allows a top-level `metadata` field, "a map from string keys to string values", for client-specific properties, and recommends reasonably unique key names. The reference validator (`skills-ref`) rejects unknown top-level fields and types `metadata` as `dict[str, str]`. Therefore:

- `metadata: { snaglog-repo: owner/repo }` — valid, and what `snaglog init` writes.
- A top-level `snaglog-repo:` — invalid.
- A nested map such as `metadata: { snaglog: { repo: … } }` — invalid.

## Labels

There is no established standard for skill-friction labels. snaglog uses `skill-friction` plus `skill:<name>`, as the project brief specifies.

## Reporting design rules

These rules come from the M0 review of how skill-friction reporting can go wrong; snaglog implements them itself:

- **Preflight before drafting:** `command -v gh` → `gh auth status` → `gh repo view <repo>`, each failure with its own remediation and a fallback to the local file.
- **What the user approves is exactly what is submitted:** sanitisation happens before the preview, and the preview lists what was redacted.
- **Mask before truncating**, so a cut-off token cannot escape the masking.
- **Labels are try-then-omit:** `gh issue create --label` fails as a whole when a label is missing, so retry once without labels; never create labels while filing (reporters usually lack permission).
- **Dedup by search:** `gh issue list --state all --search "<distinctive words>"` scoped to the skill's label; a near-match gets a comment instead of a new issue.
- **Never file unattended.** Auto-filing from an agent is a prompt-injection vector; without an explicit user approval the report goes to the local file.
- **No local context in the body:** no project names, paths under the home directory, internal URLs or hostnames.

## Evals

The brief names caliper as the eval runner. Measured against the trust policy it falls short, and Claude Code turns out to ship an official eval runner. Both are documented here; **the choice is pending the project owner's decision.**

### caliper (`caliper-eval`)

- **Package:** PyPI [`caliper-eval`](https://pypi.org/project/caliper-eval/) 0.24.0 (2026-11-15), Python ≥ 3.10, MIT, command `caliper`.
- **Spec file:** `<skill>.eval.yaml` next to `SKILL.md`; tasks with `name`, `prompt`, and `expect` (LLM rubric), `assert` (Python) or `activates`. No tags field.
- **Ablation:** `--ablate <skill-name>` records a run without the skill; comparison is a separate `caliper compare … --format json` step.
- **Results:** JSON per run, including per-task scores and token usage — and also prompts, agent output and transcripts.
- **Exit codes:** 0 even when every task fails.
- **Backends:** agent CLIs — `claude-code`, `codex`, `opencode` and others.
- **Trust problems:** one dominant maintainer (346 of ~353 commits), pre-1.0 with breaking schema changes between minors, usage metrics sent to PostHog **by default** (`CALIPER_TELEMETRY_DISABLED=1` turns them off).

### Claude Code `claude plugin eval` (official)

Built into Claude Code (present in 2.1.291; `claude plugin eval --help`):

- Runs eval cases (`evals/**/case.yaml`, or `prompt.md` + `graders/*.md`) against a plugin or a skills directory, on the local machine, as the user.
- **Ablation built in:** `--ablation with-without` (the default when a plugin resolves) runs a no-plugin baseline arm and reports the score delta.
- **Tags:** `--tag` filters cases, which maps directly onto the golden / real-usage / owner-reviewed split.
- **Cost control:** `--max-cost-usd` is a hard ceiling; `--runs` and `--concurrency` bound the work.
- **Exit code:** `--threshold <0..1>` makes a run exit 1 when any case scores below it.
- **Results:** `--json [path]` and `aggregate-result.json` under `--output-dir`.
- **Data risk:** the HTML report (scores, prompts, grader verdicts) is **published to claude.ai by default** when the account supports it. snaglog must always pass `--no-publish` and never `--publish-report`. Scaffold scripts and real MCP servers run only on explicit opt-in flags, which snaglog never passes by default.
- **Limit:** evaluates with Claude Code only; there is no Codex equivalent known yet.

Case schema details (`case.yaml` fields, grader types, result JSON shape) are still to be verified before M4.

## Agent telemetry

Only the agents' own native OpenTelemetry export is used; see [AGENT-ADAPTERS.md](AGENT-ADAPTERS.md) for details.

| Agent | Native export | Skill-aware |
|---|---|---|
| Claude Code | Yes (env vars in `~/.claude/settings.json`) | `skill_activated` event; custom skill names redacted unless detailed logging is on |
| Codex | Yes (`[otel]` in `~/.codex/config.toml`) | `codex.skill_invocation` event |
| Copilot in VS Code | Yes (`github.copilot.chat.otel.*`) | `skill_name` on tool spans |
| OpenCode, Cursor, Gemini CLI | Not via official native export today | Not supported until they offer one |
| ChatGPT web/desktop | No | Not supported |

**Coexisting with other local tools.** Other local OTel collectors commonly bind the standard OTLP port `4318`, and some rewrite agent settings to point at themselves or force protobuf through shared environment variables. snaglog therefore:

1. On `EADDRINUSE`, reports which process owns the port instead of failing silently; the port is configurable.
2. Has `connect` re-check the agent's effective endpoint and warn when something else has redirected it.
3. Answers protobuf bodies with HTTP `415` (until protobuf is supported) and explains it on the Connections page — never a silent `200`.
4. Enforces privacy at ingest with an allow-list, so whatever extra logging another tool turned on never reaches disk.
