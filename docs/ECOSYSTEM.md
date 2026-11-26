# Ecosystem

The standards, official agent features and tools snaglog builds on, and the rules for adding anything else. Researched 2026-11-26 from official documentation and source code.

## Trust policy

Security is the first requirement: snaglog handles private skill repositories, agent telemetry and issue text. Therefore:

1. **No data leaves the machine except what the user explicitly approves** (a snag report shown in full before filing). The receiver and dashboard bind `127.0.0.1` only; snaglog sends no telemetry; any child process snaglog starts runs with its telemetry and any report publishing switched off.
2. **Everything snaglog builds on is official:** the agents' own built-in OpenTelemetry export, hooks and eval command, published standards (Agent Skills, OpenTelemetry OTLP), GitHub's official `gh` CLI, and Node.js built-in modules. Community plugins, hook bridges, third-party collectors and third-party eval runners are not used, even where they would add agent coverage.
3. **No npm or PyPI dependencies** unless the project owner approves one explicitly; any candidate must be an official package from the vendor it integrates with.
4. **No third-party code is copied.** Secret-masking patterns are written from each vendor's official token-format documentation (for example GitHub's token prefixes and AWS access key ID prefixes) and tested in snaglog.
5. **One embedded asset:** the dashboard's icons are shape data from [Lucide](https://lucide.dev) (ISC, `lucide-static` 1.72.0, a release at least two weeks old when taken), sanitized to plain drawing elements and embedded in the page; nothing is loaded at runtime. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

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

## Evals: Claude Code `claude plugin eval`

snaglog uses Claude Code's official, built-in eval command and does not ship its own runner. Source: [Test plugins with evals](https://code.claude.com/docs/en/plugin-evals.md); format confirmed locally with `claude plugin eval init --bare` on Claude Code 2.1.291.

**Requirements:** Claude Code ≥ 2.1.269 (`disallowed_tools` needs ≥ 2.1.299); git ≥ 2.31 if git is installed. `snaglog eval` checks both before running.

### Case format

A case is a directory under the eval dir (`evals/` by default; `<eval dir>/**` is searched recursively) holding `prompt.md`, `case.yaml` or both, plus at least one grader.

```markdown
<!-- evals/deploy-preview/snag-42-missing-flag/prompt.md -->
---
name: snag-42-missing-flag
description: Reproduces snag #42 (documented --env flag rejected)
tags: [skill:deploy-preview, real-usage, snag:42]
runs: 3
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

Deploy a preview of the current branch to the staging environment.
```

```markdown
<!-- evals/deploy-preview/snag-42-missing-flag/graders/uses-skill.md -->
---
type: tool_used
tool: Skill
arm: both
---
```

- **`prompt.md` frontmatter:** `name`, `description`, `tags`, `plugins`, `runs` (default 3), `expected_outcome`, `model`, `max_turns`, `timeout_seconds`, `allowed_tools`, `disallowed_tools`, `append_system_prompt`, `env` (`EVAL_*` keys only). Unknown keys are errors.
- **`case.yaml`** (`schema_version: "1.1"`) adds `context.scaffold_script`, `context.history_file`, `context.add_dirs` and inline `graders`.
- **Graders** (`graders/<name>.md`, fields `type`, `weight`, `arm`):
  - free, computed from transcript and files: `regex`, `tool_used`, `tool_order`, `file_exists`;
  - paid, judge model: `llm`, `baseline`.
  - There are no custom-code graders.

### How snaglog uses it

1. **Layout:** one folder per skill, `<evals dir>/<skill>/<case>/`, where `<evals dir>` is `evals/` in a skills repo (skills in `skills/`) and `.claude/evals/` in a project (skills in `.claude/skills/`). Every case is tagged `skill:<name>` plus exactly one category tag — `golden` (~5 %), `real-usage` (~80 %, includes every snag-derived case, which also gets `snag:<issue>`), or `owner-reviewed` (~15 %). `snaglog eval <skill>` runs with `--tag skill:<name>`; the dashboard reports the category mix against the recommended split.
2. **Free graders first:** snag cases prefer `regex`, `tool_used`, `tool_order` and `file_exists`; `llm` graders are added only when a deterministic check is impossible.
3. **Ablation:** `snaglog eval <skill> --ablate` passes `--ablation with-without` and records `meanDelta` / per-case `delta`; without `--ablate` it passes `--ablation none` to halve cost. The baseline arm runs **without the whole plugin**, i.e. without any of the repo's skills, so the delta measures what the skills repo adds on this skill's cases rather than this one skill in isolation.
4. **Data never leaves the machine:** snaglog always passes `--no-publish` (by default the report is published to claude.ai as a private artifact) and never `--publish-report`, `--scaffold`, `--allow-real-servers`, `--mocks off` or `--trust-plugin`; a test asserts the exact argument list. Agent and judge calls use the user's own Claude credentials, as any Claude Code session does.
5. **What is stored:** `--json` and `--output-dir` point into a temporary directory that is deleted after the run. From the result (`schemaVersion: 1`) snaglog keeps, in `~/.snaglog/evals/<skill>/<time>.json`: per-case `name`, `score`, `delta`, error/aborted flags, the mean score and delta, `costUsd`, `durationSeconds`, `claudeVersion`, `partial`, plus the skill's git commit, whether the skill had uncommitted changes, a content fingerprint and `allPassed`. Prompts, transcripts, grader explanations and evidence are dropped. `--keep-report` instead keeps Claude Code's full report in the git-ignored `evals/results/`.
6. **Pass/fail and exit codes:** 0 = all cases ≥ `--threshold`, 1 = below threshold or could not run, 2 = partial (cost ceiling or credential), 130/143 = interrupted. snaglog reads scores from the JSON and uses the exit code only to tell "ran" from "partial" or "failed to run".
7. **Cost:** evals spend money on the user's Claude account, so `snaglog eval` **always** prints the plan and asks before running anything (`--yes` skips the question, `--dry-run` only prints). Every run gets a hard ceiling, `--max-cost-usd` (default $1 per skill). The estimate is the last recorded cost per case × the current case count (×2 or ÷2 when ablation changes); skills without history show "unknown", and the hard ceiling still bounds them. By default only skills whose `SKILL.md`, scripts or eval cases changed since their last recorded eval are selected; `--all` selects every skill with cases.
8. **Tool checks before asking:** `claude --version` (≥ 2.1.269) and `git --version` (≥ 2.31); both are free.

### Limits and risks

- **Claude Code only.** There is no official Codex eval runner; Codex skill quality is measured through telemetry and snags until OpenAI ships one.
- **Server-side gate.** The docs list "currently unavailable" as a state Anthropic can switch on; `snaglog eval` reports it clearly instead of failing obscurely.
- **Eval target.** Verified offline (no model calls) on Claude Code 2.1.291: a folder whose `skills/<name>/SKILL.md` exist loads as a plugin from its path, without a `plugin.json` (`claude --plugin-dir <dir> plugin details <name>` lists its skills). `snaglog eval` therefore targets the repo root in a skills repo and the project's `.claude/` folder in a project; the default eval dir is `evals/` below that target (`evals/` or `.claude/evals/`).
- **Not documented:** a per-case boolean pass (snaglog derives it as score ≥ threshold), token counts, and whether the JSON contains full transcripts (snaglog assumes it does and drops everything outside its allow-list).

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
