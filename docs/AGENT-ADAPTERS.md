# Agent adapters

How each agent exports OpenTelemetry, how snaglog recognises a **skill invocation** in that stream, and how the raw records become `SkillEvent`s. Verified 2026-11-26 against official documentation and source code (links per section).

> **Sample provenance.** The example payloads below are *reconstructed* from the documented attribute names and the agents' source code and anonymised by hand. They have **not yet been captured from a live agent**. Fields marked `UNVERIFIED` (value types, scope names, exact tool-name strings) must be confirmed with captured samples before the M3 adapter tests are frozen; see [Open items](#open-items).

## Common shape

Adapters receive one decoded OTLP `ExportLogsServiceRequest` (`resourceLogs[].scopeLogs[].logRecords[]`) and return zero or more events:

```ts
type SkillEvent = {
  time: string;          // ISO 8601
  agent: string;         // "claude-code", "codex", ...
  model?: string;
  skill: string;         // never recorded for activity outside a skill
  kind: "invoked" | "tool_call" | "error" | "completed";
  durationMs?: number;
  success?: boolean;
  tokens?: number;
  sessionId: string;     // salted hash of the agent's session id
  user?: string;         // team mode only, alias
};
```

Rules that apply to every adapter:

1. **Allow-list, not deny-list.** An adapter copies only the fields it needs into `SkillEvent`; the raw record is never written to disk. Prompt text, assistant responses, tool parameters, tool input, tool output, error messages, emails, account ids, host names and paths are therefore dropped even if the user (or another tool) enabled detailed logging.
2. **Identify events by the `event.name` attribute**, not by the log body or scope name.
3. **Accept any `AnyValue` type** (`stringValue`, `intValue` as string or number, `boolValue`, `doubleValue`) — both agents format booleans and numbers as strings in places.
4. **`sessionId`** is `sha256(localSalt + agentSessionId)` truncated; the salt lives in `.snaglog/` and never leaves the machine.
5. **Attribution window.** Neither agent tags every tool call with the active skill, so adapters keep a small per-session state: after an `invoked` event, tool results in the same session (and, for Claude Code, the same `prompt.id`) are attributed to that skill until the window closes. Window close produces the `completed` event. `completed` and skill-level `durationMs` are therefore **inferred**, not reported by the agent.

## Recognition reliability

| Agent | Skill invocation event | Real skill name by default | Tool calls linked to skill | Verdict |
|---|---|---|---|---|
| Claude Code | `claude_code.skill_activated` | **No** for custom skills (`custom_skill`) | By `session.id` + `prompt.id` + order (inferred) | Reliable **only with `OTEL_LOG_TOOL_DETAILS=1`** |
| Codex | `codex.skill_invocation` (builds after 2026-09-30) | Yes | By `conversation.id` + time order (inferred, weaker) | Reliable for explicit use, best-effort for implicit |
| Copilot (VS Code) | `execute_tool` span with `github.copilot.tool.parameters.skill_name` | Yes | Same trace | Reliable (later milestone; spans, not logs) |
| ChatGPT web/desktop | — | — | — | **Not supported**: no telemetry export |

## Claude Code

Sources: [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage), [Settings](https://code.claude.com/docs/en/settings), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

### Configuration written by `snaglog connect claude-code`

Set in the `env` block of the **user** settings file `~/.claude/settings.json`. Project-level `.claude/settings.json` and `.claude/settings.local.json` ignore OTel exporter variables (they can only turn a signal off), and managed settings override user values — `connect` must detect and report a managed `OTEL_EXPORTER_OTLP_ENDPOINT`.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_TRACES_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_LOGS_EXPORT_INTERVAL": "5000",
    "OTEL_LOG_USER_PROMPTS": "0",
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",
    "OTEL_LOG_TOOL_DETAILS": "<decision pending, see below>"
  }
}
```

- `http/json` must be set explicitly: since v2.1.323 the default for an `http(s)://` endpoint is `http/protobuf`.
- With a base endpoint the SDK appends `/v1/logs` (standard OTel behaviour; inferred, not stated in the docs). The receiver still answers `/v1/metrics` and `/v1/traces` with `200` and discards the body, so a user who enables those signals gets no export errors.
- Metrics are disabled because the `api_request` log event already carries tokens and cost, with `skill.name` attribution.
- `OTEL_*` variables are not passed to Bash, hooks or MCP subprocesses, so connecting does not leak into the user's tools.

### Events used

| `event.name` | Used for | Attributes read |
|---|---|---|
| `skill_activated` | `kind: "invoked"`, opens window | `skill.name`, `invocation_trigger` (`user-slash` \| `claude-proactive` \| `nested-skill`), `skill.source`, `session.id`, `prompt.id`, `event.sequence` |
| `tool_result` | `kind: "tool_call"` or `"error"` inside a window | `tool_name`, `success`, `duration_ms`, `error_type`, `session.id`, `prompt.id`, `event.sequence` |
| `tool_decision` with `decision=reject` | counted as a retry signal (rejected calls emit no `tool_result`) | `tool_name`, `decision` |
| `api_request` | `tokens`, `model` | `skill.name`, `model`, `input_tokens`, `output_tokens`, `cache_*_tokens`, `duration_ms` |
| `api_error` | reliability signal | `skill.name`, `error`-free fields only (`status_code`, `attempt`) |
| `user_prompt` | **closes** the window (new `prompt.id`); content is redacted by default and never read | `prompt.id` only |

Everything else (`assistant_response`, `api_request_body`, hooks, plugins, …) is ignored.

### Recognising a skill

1. **Primary:** `skill_activated` is emitted both when Claude calls the Skill tool and when the user types a slash command.
2. `skill.name` is the real name for bundled and official-marketplace skills. **For user-defined skills and third-party plugin skills it is `custom_skill`** unless `OTEL_LOG_TOOL_DETAILS=1` is set; `api_request.skill.name` shows `third-party` in the same situation.
3. A team's private skills are exactly that case. Without the flag, snaglog can count *that* a custom skill ran, but not *which* one.
4. With the flag, `tool_result.tool_parameters` for the Skill tool also contains `skill_name`, and the tool name is presumably `Skill` (`UNVERIFIED`); snaglog uses `skill_activated` and treats this only as a cross-check.

**Cost of the flag:** `OTEL_LOG_TOOL_DETAILS=1` also exports the untruncated Bash `full_command`, `tool_input` (file paths, URLs, up to ~4 KB) and error text. In local mode these go only to `127.0.0.1` and the adapter's allow-list drops them before storage. In team mode they would cross the network — see [Open items](#open-items).

### PII handling

Dropped: `user.email`, `user.account_uuid`, `user.account_id`, `user.id`, `organization.id`, `host.name`, `host.id`, `workspace.host_paths`, `vcs.*`, `prompt`, `prompt_text`, `response`, `tool_parameters`, `tool_input`, `error`. Hashed: `session.id`.

### Example (reconstructed, anonymised)

`skill_activated` followed by a failed Bash call in the same prompt, with `OTEL_LOG_TOOL_DETAILS=1`:

```json
{
  "resourceLogs": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "claude-code" } },
      { "key": "service.version", "value": { "stringValue": "2.1.332" } }
    ]},
    "scopeLogs": [{
      "scope": { "name": "com.anthropic.claude_code.events" },
      "logRecords": [
        { "timeUnixNano": "1764150000000000000", "attributes": [
          { "key": "event.name", "value": { "stringValue": "skill_activated" } },
          { "key": "event.sequence", "value": { "intValue": "41" } },
          { "key": "session.id", "value": { "stringValue": "00000000-0000-4000-8000-000000000001" } },
          { "key": "prompt.id", "value": { "stringValue": "00000000-0000-4000-8000-0000000000aa" } },
          { "key": "skill.name", "value": { "stringValue": "deploy-preview" } },
          { "key": "invocation_trigger", "value": { "stringValue": "claude-proactive" } },
          { "key": "skill.source", "value": { "stringValue": "projectSettings" } }
        ]},
        { "timeUnixNano": "1764150004000000000", "attributes": [
          { "key": "event.name", "value": { "stringValue": "tool_result" } },
          { "key": "event.sequence", "value": { "intValue": "44" } },
          { "key": "session.id", "value": { "stringValue": "00000000-0000-4000-8000-000000000001" } },
          { "key": "prompt.id", "value": { "stringValue": "00000000-0000-4000-8000-0000000000aa" } },
          { "key": "tool_name", "value": { "stringValue": "Bash" } },
          { "key": "success", "value": { "stringValue": "false" } },
          { "key": "error_type", "value": { "stringValue": "ShellError" } },
          { "key": "duration_ms", "value": { "stringValue": "340" } },
          { "key": "error", "value": { "stringValue": "<dropped by adapter>" } },
          { "key": "tool_parameters", "value": { "stringValue": "<dropped by adapter>" } }
        ]}
      ]
    }]
  }]
}
```

`UNVERIFIED`: scope name, `intValue` vs string for `event.sequence`, string vs int for `duration_ms`.

Resulting events:

```json
[
  { "time": "2025-11-26T09:40:00.000Z", "agent": "claude-code", "skill": "deploy-preview", "kind": "invoked", "sessionId": "a1b2c3d4e5f6" },
  { "time": "2025-11-26T09:40:04.000Z", "agent": "claude-code", "skill": "deploy-preview", "kind": "error", "success": false, "durationMs": 340, "sessionId": "a1b2c3d4e5f6" }
]
```

## Codex

Sources: `openai/codex` at commit `af71942` — `codex-rs/config/src/types.rs` (`OtelConfigToml`), `codex-rs/core/src/config/otel.rs`, `codex-rs/otel/README.md`, `codex-rs/otel/src/events/*.rs`, `codex-rs/otel/src/skill_invocation.rs`, `codex-rs/skills/src/invocation.rs`; [config reference](https://learn.chatgpt.com/docs/config-file/config-reference); [skills](https://learn.chatgpt.com/docs/build-skills). (`developers.openai.com/codex/*` now redirects to `learn.chatgpt.com/docs/*`.)

### Configuration written by `snaglog connect codex`

In `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). `[otel]` is ignored in project-level `.codex/config.toml`; admins can enforce it through `requirements.toml`, which `connect` must detect. There is no environment-variable override for the exporter.

```toml
[otel]
environment = "dev"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }
trace_exporter = "none"
# metrics_exporter is left as the user had it; see note below
```

- The endpoint must be the **full signal path** (`/v1/logs`); Codex does not append it.
- `tool_result.max_bytes = 0` is proposed (not forced) to stop the 2 KB tool-output preview from being exported; whether `0` fully disables it is `UNVERIFIED`.
- `metrics_exporter` defaults to `statsig` (OpenAI-bound, follows `analytics.enabled`). snaglog does not touch it, and the README says so.

### Events used

| `event.name` | Used for | Attributes read |
|---|---|---|
| `codex.skill_invocation` | `kind: "invoked"`, opens window | `skill.name`, `skill.scope` (`user` \| `repo` \| `system` \| `admin`), `skill.invocation_type` (`explicit` \| `implicit`), `conversation.id`, `turn.id`, `model` |
| `codex.tool_result` | `tool_call` / `error` inside a window | `tool_name`, `tool_namespace`, `success`, `duration_ms`, `conversation.id`, `call_id` |
| `codex.user_prompt` | closes the window (new turn); content is `[REDACTED]` by default and never read | — |
| `codex.turn_cost` / `codex.api_request` | `tokens`, `model` | token fields only (exact names `UNVERIFIED`) |

### Recognising a skill

1. `codex.skill_invocation` is emitted whenever the OTLP log exporter is on, with no extra opt-in, and by design excludes skill contents, paths, emails, prompts, tool arguments and output.
2. **Explicit** invocations (`$skill`, `/skills`) are reliable. **Implicit** ones are detected by Codex itself when a shell command reads the skill's `SKILL.md` or runs a script under its `scripts/` directory — documented as best-effort and deduplicated per skill per turn.
3. Builds older than 2026-09-30 have no such event. snaglog will **not** fall back to parsing `tool_result.arguments` for `SKILL.md` paths, because that requires reading tool arguments; those builds are reported as "skill events unavailable — upgrade Codex" on the Connections page.
4. `codex.tool_result` carries no `turn.id`, so attribution to the active skill is by `conversation.id` and time order until the next `codex.user_prompt`. Concurrent skills in one turn cannot be separated.

### PII handling

Codex exports some sensitive fields **by default**, so dropping them at ingest is mandatory: `arguments` (full tool arguments), `output` (output preview), `user.email` and `user.account_id` on every event, `host.name` on the resource. Hashed: `conversation.id`.

### Example (reconstructed, anonymised)

```json
{
  "resourceLogs": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
      { "key": "service.version", "value": { "stringValue": "0.174.0" } },
      { "key": "env", "value": { "stringValue": "dev" } },
      { "key": "host.name", "value": { "stringValue": "<dropped by adapter>" } }
    ]},
    "scopeLogs": [{
      "logRecords": [
        { "timeUnixNano": "1764150000000000000", "attributes": [
          { "key": "event.name", "value": { "stringValue": "codex.skill_invocation" } },
          { "key": "conversation.id", "value": { "stringValue": "00000000-0000-4000-8000-000000000002" } },
          { "key": "turn.id", "value": { "stringValue": "turn-3" } },
          { "key": "skill.name", "value": { "stringValue": "deploy-preview" } },
          { "key": "skill.scope", "value": { "stringValue": "repo" } },
          { "key": "skill.invocation_type", "value": { "stringValue": "implicit" } },
          { "key": "model", "value": { "stringValue": "<model>" } }
        ]},
        { "timeUnixNano": "1764150002000000000", "attributes": [
          { "key": "event.name", "value": { "stringValue": "codex.tool_result" } },
          { "key": "conversation.id", "value": { "stringValue": "00000000-0000-4000-8000-000000000002" } },
          { "key": "tool_name", "value": { "stringValue": "exec_command" } },
          { "key": "call_id", "value": { "stringValue": "call_0001" } },
          { "key": "success", "value": { "stringValue": "true" } },
          { "key": "duration_ms", "value": { "stringValue": "25" } },
          { "key": "arguments", "value": { "stringValue": "<dropped by adapter>" } },
          { "key": "output", "value": { "stringValue": "<dropped by adapter>" } },
          { "key": "user.email", "value": { "stringValue": "<dropped by adapter>" } }
        ]}
      ]
    }]
  }]
}
```

`UNVERIFIED`: `service.name` value, scope name, the `exec_command` tool-name string, token field names on `turn_cost`.

## Later agents (summary only)

| Agent | Path | Notes |
|---|---|---|
| GitHub Copilot (VS Code) | `github.copilot.chat.otel.enabled` + `.otlpEndpoint`; `.captureContent` stays `false` | Skill name on `execute_tool` spans (`github.copilot.tool.parameters.skill_name`); needs a traces endpoint. Code defaults to http/json, docs say protobuf. |
| OpenCode | `@devtheops/opencode-plugin-otel`, `OPENCODE_OTLP_PROTOCOL=http/json` | No skill event; skill name only inside span tool input. |
| Cursor, Gemini CLI | `o11y-dev/opentelemetry-hooks` | Sends protobuf/gRPC only, so needs protobuf support first. Not skill-aware. |
| ChatGPT web/desktop | — | No telemetry export; not supported. |

## Writing a new adapter

To be expanded in `CONTRIBUTING.md` (M8). In short: export `{ agent, match(resource), toEvents(record, state) }` from `cli/collect/otel/adapters/<agent>.mjs`; only copy allow-listed fields; add anonymised captured fixtures under `test/fixtures/otel/<agent>/`, plus a test proving prompt and tool content never reach the output.

## Open items

1. **Claude Code custom skill names need `OTEL_LOG_TOOL_DETAILS=1`.** Without it, private team skills all appear as `custom_skill`. Options: (a) `connect` enables the flag after explaining what it exports, with snaglog's allow-list dropping the extra data at ingest (local mode); (b) leave it off and show only aggregate "custom skill" numbers; (c) a Claude Code hook that reports only the skill name. Recommendation: (a) for local mode. For team mode, the connected machine should run a local snaglog relay that strips fields before forwarding, so detailed data never crosses the network.
2. **Live samples.** Capture real, anonymised payloads from Claude Code and Codex (one short scripted session each, telemetry pointed at a throwaway local capture server via environment variables only) to replace the reconstructed examples and resolve every `UNVERIFIED` field. Codex is not installed on the development machine yet.
3. **Protobuf.** Claude Code and Copilot can both be told to use JSON, but other local tools (hedge-local) force protobuf through shared environment variables. Until protobuf lands, the receiver returns `415` for protobuf and the Connections page explains why.
