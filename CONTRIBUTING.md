# Contributing to snaglog

Thanks for helping. The most valuable contributions are **new agent adapters** (see below), better snag grouping, and dashboard improvements.

## Ground rules

- **Security first.** snaglog handles private skills, agent telemetry and issue text. Read the trust policy in [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md) before proposing an integration.
- **Official building blocks only.** Agents are integrated through their own built-in telemetry, hooks or eval commands; GitHub through `gh`. No community plugins, hook bridges or third-party collectors.
- **No npm dependencies.** The CLI uses Node.js built-in modules. Skill scripts (`skills/*/scripts/`) are copied into other repositories and must stay single-file and dependency-free; they must not import from `cli/`.
- **Nothing leaves the machine without the user's approval**, and nothing that costs money (model calls, evals) runs without showing the cost and asking.
- **Everything in the repository is in English**: code, comments, `SKILL.md` files, UI text, docs and commit messages.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(eval): …`, `fix(dashboard): …`, `docs: …`).
- `SKILL.md` files stay under 500 lines, with numbered steps, a way to verify each step, and an error recovery table.

## Development

Requirements: Node.js 22 or later and git.

```bash
npm test
```

Run the CLI from the checkout:

```bash
node cli/snaglog.mjs --help
```

```bash
node cli/snaglog.mjs dashboard --demo
```

### Tests must not touch the real world

Tests never call GitHub, a model, a real agent session or a real agent config file. Use these switches and fakes:

| Variable | Replaces | Fake in `test/fixtures/` |
|---|---|---|
| `SNAGLOG_GH` | the `gh` CLI | `fake-gh.mjs` (records calls, answers from `FAKE_GH_SCENARIO`) |
| `SNAGLOG_CLAUDE` | the `claude` CLI used by `snaglog eval` | `fake-claude.mjs` (writes a result file, no model calls) |
| `SNAGLOG_GIT` | `git push` in `fix-snags` | `fake-git.mjs` |
| `SNAGLOG_HOME` | `~/.snaglog` | a temporary directory |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | the agents' config folders | temporary directories |

A quick way to prove a change keeps this promise is to run the suite with an empty `HOME` and trap scripts named `gh` and `claude` first on `PATH` that record any call: nothing may reach them.

## Project layout

```
cli/
  snaglog.mjs            command entry point
  init.mjs               snaglog init
  eval.mjs               snaglog eval (claude plugin eval)
  connect/               connect / disconnect per agent, Claude Code skill-name hook
  collect/
    snags.mjs, evals.mjs collectors
    otel/                OTLP receiver, attribution tracker, adapters/
  dashboard/             server, metrics, single-page UI, demo data
  lib/                   shared helpers
skills/
  log-snag/              report a snag (SKILL.md + scripts/file-snag.mjs)
  fix-snags/             fix snags (SKILL.md + scripts/list-snags.mjs, fix-pr.mjs)
docs/                    design notes
test/                    node:test suites and fixtures
```

## Writing a new agent adapter

An adapter turns one agent's OpenTelemetry log records into snaglog's `SkillEvent`s. Read [docs/AGENT-ADAPTERS.md](docs/AGENT-ADAPTERS.md) first: it describes the common event shape, the existing adapters and what was verified about each agent.

### 1. Check the agent qualifies

- The agent must have **official, built-in** OpenTelemetry export (logs or spans) that can target a local endpoint with the OTLP JSON encoding.
- You must be able to tell, from that telemetry alone, **when a skill is invoked and which one**. Write down which event and attribute carry it, from the agent's official documentation or source.
- If skill names are hidden unless the user enables logging of tool inputs or prompts, do not ask users to enable it; look for a safer source (as the Claude Code adapter does with a local hook and API events), or document the agent as unsupported.

### 2. Capture a real sample

Point the agent at a throwaway local server (environment variables or a session-only settings file; never edit the user's real config) and run one short session that uses a skill. Then anonymise it before committing: replace every identifier (session, prompt, user, account, organisation, request ids) consistently, remove error text, paths and hostnames, and drop unrelated events. Keep a `_provenance` field saying what it is. Delete the raw capture.

Running a real agent session costs money on your account; keep it to one short session.

### 3. Write the adapter

Create `cli/collect/otel/adapters/<agent>.mjs`:

```js
import { safeSkillName, SkillTracker } from '../tracker.mjs';
import { toBool, toNumber } from '../otlp.mjs';

export const agent = 'my-agent';

// Decide from the resource or the event name whether a record is ours.
export function matches({ resource, attrs }) {
  return resource['service.name'] === 'my-agent';
}

export function createAdapter({ anonymize, hints }) {
  const tracker = new SkillTracker(agent);

  function handle({ attrs, time }) {
    const raw = attrs['session.id'];
    if (typeof raw !== 'string') return [];
    const sessionId = anonymize(raw); // never store the raw id

    switch (attrs['event.name']) {
      case 'my_agent.skill_used':
        return tracker.open(sessionId, { skill: safeSkillName(attrs['skill.name']), time });
      case 'my_agent.tool_result':
        return tracker.toolResult(sessionId, { time, success: toBool(attrs.success), durationMs: toNumber(attrs.duration_ms), tool: attrs.tool_name });
      case 'my_agent.turn_end':
        return tracker.close(sessionId, time);
      default:
        return [];
    }
  }

  return { agent, matches, handle, sweep: (now) => tracker.sweep(now) };
}
```

Rules:

- **Read an allow-list of attributes only** and list them in the file header. Never copy prompt text, responses, tool arguments, tool output, error text, emails, account or host identifiers into an event.
- Use `SkillTracker` for attribution: `open` on invocation, `toolResult` for tool calls inside the skill, `tokens` for usage, `close` (or `closeScope`) at the end of a turn. Use `safeSkillName` for every skill name.
- Accept every OTLP value encoding (`stringValue`, `intValue` as number or string, `boolValue`); the helpers in `otlp.mjs` do this.

Register the module in `ADAPTERS` in `cli/collect/otel/receiver.mjs`.

### 4. Add `connect` support

Create `cli/connect/<agent>.mjs` exporting `name`, `configPath(env)`, `plan({ text, path, endpoint, hookCommand })`, `revert({ text, path, record, endpoint })` and `notes`, and add it to `AGENTS` in `cli/connect/common.mjs`. `plan` must:

- change only what snaglog needs (prefer log-specific settings, so other telemetry the user sends elsewhere keeps working);
- turn every prompt or content logging option **off**;
- return a readable line per change and warnings when it redirects something that went elsewhere;
- refuse layouts it cannot edit safely rather than guess.

`revert` undoes only snaglog's keys and keeps later user edits. Remove the agent from `UNSUPPORTED` in the same file.

### 5. Test it

Add fixtures under `test/fixtures/otel/` and tests in `test/otel.test.mjs` and `test/connect.test.mjs` that prove:

- a skill session becomes the expected `invoked` / `tool_call` / `error` / `completed` events;
- tool calls outside the skill are not attributed to it;
- **no sensitive value from the fixture reaches disk**: put `SECRET-…` markers in prompt, tool and identity fields and assert they are absent from everything under `SNAGLOG_HOME`;
- `connect` then `disconnect` restores the original config file byte for byte, and a later user edit survives `disconnect`.

### 6. Document it

Add a section to [docs/AGENT-ADAPTERS.md](docs/AGENT-ADAPTERS.md) (configuration written, events used, how a skill is recognised, what is verified and what is not, personal data dropped) and update the agent table in the README.

## Reporting security issues

Please do not open a public issue for a security problem. Contact the maintainers privately first.
