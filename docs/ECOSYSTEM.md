# Ecosystem

What already exists around skill friction reporting, skill fixing, skill evals and agent telemetry, and what snaglog takes from each. Researched 2026-11-26 by reading each project's repository read-only; nothing was installed or executed. Facts change quickly in this space, so treat versions and activity as a snapshot.

## Summary

| Project | Area | License | Activity (2026-11) | Skill-aware | Role for snaglog |
|---|---|---|---|---|---|
| [bstegemoller/skill-feedback](https://github.com/bstegemoller/skill-feedback) | Reporting | Apache-2.0 | Dormant | Yes | Ideas: friction taxonomy, confidence section |
| [joestump/claude-plugin-sdd](https://github.com/joestump/claude-plugin-sdd) `report-friction` | Reporting | MIT | Active (39★) | Yes | Closest prior art; ideas: preflight, dedup, labels |
| [psylch/skill-issue-skill](https://github.com/psylch/skill-issue-skill) | Reporting | MIT | Dormant | Yes | Origin of `skill:<name>` label |
| [netresearch/retro-skill](https://github.com/netresearch/retro-skill) | Reporting / fixing | MIT + CC-BY-SA-4.0 | Very active (31★) | Yes | Ideas: secret masking patterns, repo resolution |
| [medhaja/skill-fix-loop](https://github.com/medhaja/skill-fix-loop) | Fixing | MIT | Single-day prototype | Yes (synthetic) | Ideas: error normalisation, clustering |
| [edonadei/caliper](https://github.com/edonadei/caliper) (`caliper-eval`) | Evals | MIT | Very active (240★, v0.24.0) | Yes | **Runtime dependency** (external CLI) |
| [justinmaks/hedge-local](https://github.com/justinmaks/hedge-local) | Telemetry | MIT | Quiet since 2026-09 | No | Coexist (port 4318 conflict) |
| [traceroost/core](https://github.com/traceroost/core) (formerly AgentLens) | Telemetry | MIT + BUSL-1.1 parts | Active | No | Coexist (port 4318 conflict, rewrites agent config) |
| [o11y-dev/opentelemetry-hooks](https://github.com/o11y-dev/opentelemetry-hooks) | Telemetry | MIT in pyproject, no LICENSE file | Active (41★) | No | Future path for Cursor / Gemini CLI |
| [DEVtheOPS/opencode-plugin-otel](https://github.com/DEVtheOPS/opencode-plugin-otel) | Telemetry | MPL-2.0 | Active (157★) | Partly | Future path for OpenCode |

No project combines per-skill routing to the skill's own repo, consent-gated filing with a local fallback, eval tracking per skill version and skill-centric telemetry. snaglog is not redundant, but it should reuse ideas rather than reinvent them.

## Reporting

### joestump/claude-plugin-sdd — `skills/report-friction`

The most complete reporter, but hard-wired to file only against its own repository.

- **Trigger threshold:** "real cost" — wasted tokens, duplicated work, misleading instructions — with explicit non-examples (a missing `gh` only counts if the skill should have checked for it). A self-check step runs before drafting.
- **Template:** friction summary, affected skill and version, *said vs. happened* ("load-bearing"), reproduction context, workaround, estimated cost and severity, optional suggested fix.
- **Sanitisation:** destructive replacement plus a redaction log shown to the user, so the body the user approves is byte-for-byte the body that is submitted. Replaces home paths, internal URLs, credential-shaped strings, private emails and IPs.
- **Consent:** shows body, labels, redaction log and duplicate candidates; options are submit, edit then submit (via a temp file and `--from-file`), comment on existing issue, or skip. Unattended runs never submit.
- **Dedup:** `gh issue list --state all --search "<4-6 distinctive words>" --limit 5`; the agent judges near-matches semantically and can comment instead.
- **Labels:** `skill-friction` plus a type label. Labels are *try-then-omit*: `gh issue create --label` fails atomically on a missing label, so it retries once without labels and never runs `gh label create` (reporters usually lack permission).
- **Preflight:** `command -v gh` → `gh auth status` → `gh repo view`, each with its own remediation.

**snaglog borrows:** preflight trio, try-then-omit labels, displayed body = submitted body with a redaction log, comment-on-existing path, edit-then-submit via file.

### netresearch/retro-skill

A heavyweight end-of-session retrospective that routes learnings to seven destinations and opens **draft PRs** (never issues).

- **Secret masking** (`skills/retro/scripts/mask-secrets.py`): ~22 named patterns — GitHub `gh[pousr]_` / `github_pat_`, GitLab `glpat-`, `sk-` keys, AWS `AKIA`/`ASIA`, Slack `xox*`, Stripe, Hugging Face, npm, Google `AIza`, Vault, JWTs, PEM keys, auth headers, credentials in URLs and query strings, `*PASSWORD=`/`*TOKEN=` assignments — each with a test sample. It **masks before truncating**, so a cut-off token cannot escape.
- **Source-repo resolution chain:** `.claude-plugin/plugin.json` `repository` → `composer.json` → `.git/config` origin → installed-plugins registry → ask. Its own SKILL.md uses `metadata.repository`.
- Checks repository visibility before pushing and refuses PR bodies without a provenance line.

**snaglog borrows:** the pattern list (re-implemented in JavaScript, MIT-compatible) with one test per pattern, mask-before-truncate, a provenance line in issue bodies, and `metadata.repository` / `plugin.json` as fallbacks when `metadata.snaglog-repo` is missing.

### bstegemoller/skill-feedback

A prompt-only skill that drafts a report and hands it to the user to file manually; it **never** files itself, citing auto-filing as a prompt-injection vector.

**snaglog borrows:** the friction taxonomy (stale instruction, broken script, gap, ambiguity, triggering, workaround), a *confidence* field (skill fault vs. environment fault), and writing "not observed" rather than guessing. The injection concern is real; snaglog answers it with mandatory user approval and by never filing unattended.

### psylch/skill-issue-skill

Files directly, without consent or redaction, to one central tracker with pre-created `skill:<name>` labels; detects the skill from the most recent `Skill` tool call. Its body footer leaks the source project path.

**snaglog borrows:** the `skill:<name>` label convention and skill detection from the last `Skill` tool call. It is also a list of what not to do.

### Labels: `skill-friction` is not yet a shared standard

The brief assumed existing projects use `skill-friction`. In practice only `joestump/claude-plugin-sdd` applies it (bstegemoller recommends it in prose); a GitHub search found no public issues carrying it. snaglog still uses `skill-friction` + `skill:<name>`, which combines the two conventions that do exist.

## Skill metadata: `metadata.snaglog-repo`

The [Agent Skills specification](https://agentskills.io/specification) allows a top-level `metadata` field, "a map from string keys to string values", for client-specific properties, and recommends reasonably unique key names. The reference validator (`skills-ref`) rejects unknown top-level fields and types `metadata` as `dict[str, str]`. Therefore:

- `metadata: { snaglog-repo: owner/repo }` — valid, and what `snaglog init` writes.
- A top-level `snaglog-repo:` — invalid.
- A nested map such as `metadata: { snaglog: { repo: … } }` — invalid.

## Fixing

### medhaja/skill-fix-loop

A local demo app over 600 synthetic traces for three invented skills, created and last pushed on a single day. It consumes **traces**, not friction reports; it neither creates real eval cases, nor applies diffs, nor opens PRs.

**snaglog borrows (design only):** error-line normalisation (strip URLs, paths, IDs, hex, numbers) to build failure signatures; rule-based verdicts as ground truth with an LLM judge as annotation only; a separate "needs triage" bucket; one draft per root cause citing its evidence; an append-only review log; measuring before/after on held-out reports.

## Evals: caliper

snaglog shells out to the `caliper` CLI and does not ship an eval runner.

- **Package:** PyPI [`caliper-eval`](https://pypi.org/project/caliper-eval/) 0.24.0 (2026-11-15), Python ≥ 3.10, MIT, installs the `caliper` command (`pipx install caliper-eval`). Maps to `edonadei/caliper`.
- **Commands:** `run`, `validate`, `list`, `report`, `compare`, plus login and telemetry helpers.
- **Spec file:** one `<skill>.eval.yaml` **next to `SKILL.md`**. Top level: `skills`, `sandbox`, `mcp`, `user_customizations`, `tasks`. A task has a unique `name`, `prompt`, optional `setup`/`cleanup`/`history`, and at least one of `expect` (LLM-judged rubric), `assert` (Python, 30 s limit) or `activates` (exact set of skills expected to load). There is no tags/id/weight field and unknown keys fail `caliper validate`.

  ```yaml
  skills:
    - ./SKILL.md
  tasks:
    - name: Actually writes the note it claims to have saved
      prompt: "Save the note 'ship the release on Friday' to note.txt"
      expect: The agent reports that it saved the note to note.txt.
      assert: |
        from pathlib import Path
        assert Path("note.txt").exists(), "no file"
  ```

- **Ablation:** `--ablate <skill-name>` (repeatable; also `mcp:<server>`) records a run *without* that skill. Comparison is a separate step: run with the skill, then `caliper compare <ablated.json> <with.json> --format json` (fields include per-task deltas and `has_regression`). It is not a single with/without switch.
- **Results:** human table on stdout; JSON saved to `.caliper/results/<spec>/<timestamp>.json` and optionally `--output PATH`. Run metadata (backend, model, judge, k, ablated, cli version), per-task `score`, `pass_at_k`, per-attempt outcome, duration and token usage (input/output/cache). **Result JSON also contains prompts, agent output and transcripts.**
- **Exit codes:** 0 = ran (even if every task failed), 1 = bad input, 2 = could not run, 3 = reserved, 130 = interrupted.
- **Backends:** agent CLIs only — `claude-code` (default), `codex`, `pi`, `hermes`, `antigravity`, `opencode`; each must be installed and logged in.
- **Cost:** tokens and wall time only, no dollar cost, no dry-run or estimate. `caliper validate` is offline.
- **Telemetry:** caliper sends anonymous usage metrics (PostHog) by default; `CALIPER_TELEMETRY_DISABLED=1` turns them off.
- **Maturity:** pre-1.0 with schema changes between minors; one dominant maintainer. Open issues #301 (`import-trace`) and #229 (`optimize`) and the shipped `hillclimb-skill` overlap with snaglog's fix loop.

**Consequences for snaglog:**

1. Pass/fail comes from result JSON (`aggregate.avg_score`, per-task `score`), never from the exit code.
2. `snaglog eval --ablate` orchestrates two runs plus `compare`, always with `--no-user-customizations` and a fixed `--judge-model` so scores are comparable; the ablated baseline is cached until the spec changes.
3. snaglog stores only scores, outcomes, durations and token counts in `.snaglog/evals/`, and drops `prompt`, `output`, `transcript` and judge reasoning, consistent with "no prompt text or tool output".
4. snaglog sets `CALIPER_TELEMETRY_DISABLED=1` when it runs caliper, so "snaglog sends nothing anywhere" also holds for its child process.
5. Cost estimate = tasks × k × average tokens per attempt from previous runs × a user-editable price table; without history snaglog shows a token range and says it is a guess.
6. Snag-derived tasks are appended to `<skill>.eval.yaml` with the issue number in the task `name` (`snag #42: …`), since the format has no tags; snaglog runs `caliper validate` before any paid run.
7. The supported caliper version range is checked via `caliper --version` and results are parsed defensively.

## Telemetry

None of the existing local collectors is skill-aware; all of them aggregate per tool, model or session.

### hedge-local (`hcli`)

Go TUI collecting Claude Code and OpenCode OTel into SQLite. Binds `127.0.0.1:4318`, accepts **both JSON and protobuf**. Reads Claude Code *trace spans* (enhanced telemetry beta). Its setup script sets `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and `OTEL_LOGS_EXPORTER=none`, which would starve a log-based snaglog adapter.

### TraceRoost (formerly the AgentLens VS Code extension)

Local dashboard for Claude Code, Codex, Copilot, OpenCode, Cursor CLI and others. Binds `127.0.0.1:4318`, **JSON only, silently accepts and drops protobuf**. When the port is taken it moves to the next free port *and rewrites* `~/.claude/settings.json`, `~/.codex/config.toml` and Copilot settings to point at itself (after a one-time consent; `TRACEROOST_NO_AUTOCONFIG=1` disables). Its recommended setup enables prompt, tool-detail and diff logging.

### o11y-dev/opentelemetry-hooks (`otel-hook`)

No receiver: each agent runs `otel-hook` as a command hook and it exports via the Python OTel SDK. Covers Claude Code, Codex, Cursor (`~/.cursor/hooks.json`), Gemini CLI (`~/.gemini/settings.json`), Copilot CLI, OpenCode and others. Emits `gen_ai.client.*` spans; default is gRPC on 4317 and, despite the README, every HTTP mode uses protobuf. Always records the raw shell command. Not skill-aware; a skill name is only available inside tool input, which needs an opt-in flag that exposes all tool inputs.

### DEVtheOPS/opencode-plugin-otel

OpenCode plugin (MPL-2.0). Logs `tool_result` with `tool_name`, `success`, `duration_ms`; supports `http/json`. Spans carry the prompt and full tool input in `input.value` regardless of the prompt opt-in.

### GitHub Copilot in VS Code (native)

[Official OTel support](https://code.visualstudio.com/docs/copilot/guides/monitoring-agents): `github.copilot.chat.otel.enabled`, `.exporterType`, `.otlpEndpoint` (default `http://localhost:4318`), `.captureContent` (default false). Emits `invoke_agent`/`execute_tool` spans and sets **`github.copilot.tool.parameters.skill_name` on skill invocations** — the only agent researched that exposes skills natively.

### Consequences for snaglog

1. **Port 4318 is contested.** On `EADDRINUSE`, snaglog reports which process owns the port and how to resolve it; the port is configurable; `connect` warns when TraceRoost auto-config is active because it would retarget the agent away from snaglog. An optional raw-OTLP forwarder (so hedge-local or TraceRoost can keep receiving) is a later feature.
2. **JSON-only ingestion must be loud.** Until protobuf is supported, the receiver answers protobuf bodies with HTTP 415 and the dashboard's Connections page says why — never a silent 200.
3. **Privacy is enforced at ingest.** Other tools may have already turned on prompt or tool-detail logging; adapters copy an allow-list of fields into `SkillEvent` and discard the raw record, so prompt text and tool I/O never reach disk regardless of agent settings.
4. **Licenses.** opencode-plugin-otel (MPL-2.0) and opentelemetry-hooks (no LICENSE file) are integrated, not copied.
5. **Cursor has no local native OTel** (export is Enterprise-only); Cursor and Gemini CLI support will go through opentelemetry-hooks, which needs protobuf support first.
