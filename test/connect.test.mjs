// connect / disconnect tests. Agent config files live in a temp dir
// (CLAUDE_CONFIG_DIR, CODEX_HOME, SNAGLOG_HOME); real ones are never touched.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as connect } from '../cli/connect/index.mjs';
import { run as disconnect } from '../cli/connect/disconnect.mjs';
import { record, skillNameFrom } from '../cli/connect/hooks/claude-skill-hint.mjs';

let dir;
let env;

const claudeFile = () => join(dir, 'claude', 'settings.json');
const codexFile = () => join(dir, 'codex', 'config.toml');

async function call(fn, args, { answer = true } = {}) {
  const out = [];
  const err = [];
  const code = await fn(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, { env, confirm: async () => answer });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-connect-'));
  env = { SNAGLOG_HOME: join(dir, 'snaglog'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Deliberately unusual formatting: an exact restore must bring it back as is.
const CLAUDE_ORIGINAL = `{
    "model": "opus",
    "env": { "FOO": "bar", "OTEL_LOG_USER_PROMPTS": "1", "OTEL_METRICS_EXPORTER": "otlp" },
    "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo mine" } ] } ] }
}
`;

describe('claude-code', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'claude'));
    writeFileSync(claudeFile(), CLAUDE_ORIGINAL);
  });

  test('dry run shows the changes and touches nothing', async () => {
    const r = await call(connect, ['claude-code', '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.out, /env\.OTEL_LOG_USER_PROMPTS: 1 → 0/);
    assert.match(r.out, /env\.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: \(unset\) → http:\/\/127\.0\.0\.1:4318\/v1\/logs/);
    assert.match(r.out, /hooks\.PreToolUse \(matcher Skill\)/);
    assert.equal(readFileSync(claudeFile(), 'utf8'), CLAUDE_ORIGINAL);
    assert.equal(existsSync(env.SNAGLOG_HOME), false);
  });

  test('connect sets log export and privacy keys, keeps everything else, and backs up', async () => {
    const r = await call(connect, ['claude-code', '--yes']);
    assert.equal(r.code, 0, r.err);
    const settings = JSON.parse(readFileSync(claudeFile(), 'utf8'));
    assert.equal(settings.model, 'opus');
    assert.equal(settings.env.FOO, 'bar');
    assert.equal(settings.env.OTEL_METRICS_EXPORTER, 'otlp', 'metrics are left alone');
    assert.equal(settings.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json');
    for (const key of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_ASSISTANT_RESPONSES', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES']) {
      assert.equal(settings.env[key], '0', key);
    }
    assert.equal(settings.hooks.PreToolUse.length, 2, 'the existing Bash hook stays');
    assert.equal(settings.hooks.PreToolUse[1].matcher, 'Skill');
    assert.equal(settings.hooks.PreToolUse[1].hooks[0].async, true);
    assert.ok(settings.hooks.UserPromptExpansion);
    assert.ok(existsSync(join(env.SNAGLOG_HOME, 'hooks', 'claude-skill-hint.mjs')));
    const { connection } = JSON.parse(readFileSync(join(env.SNAGLOG_HOME, 'connections.json'), 'utf8'))['claude-code'];
    assert.equal(readFileSync(connection.backup, 'utf8'), CLAUDE_ORIGINAL);
  });

  test('connecting twice changes nothing the second time', async () => {
    await call(connect, ['claude-code', '--yes']);
    const once = readFileSync(claudeFile(), 'utf8');
    const r = await call(connect, ['claude-code', '--yes']);
    assert.match(r.out, /already connected/);
    assert.equal(readFileSync(claudeFile(), 'utf8'), once);
  });

  test('disconnect restores the original file byte for byte', async () => {
    await call(connect, ['claude-code', '--yes']);
    const r = await call(disconnect, ['claude-code', '--yes']);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(claudeFile(), 'utf8'), CLAUDE_ORIGINAL);
    assert.equal(existsSync(join(env.SNAGLOG_HOME, 'hooks', 'claude-skill-hint.mjs')), false);
  });

  test('after later edits, disconnect reverts only snaglog keys and keeps the edits', async () => {
    await call(connect, ['claude-code', '--yes']);
    const settings = JSON.parse(readFileSync(claudeFile(), 'utf8'));
    settings.theme = 'dark';
    settings.env.OTEL_LOGS_EXPORT_INTERVAL = '1000'; // the user changed one of our keys: theirs now
    writeFileSync(claudeFile(), JSON.stringify(settings));
    await call(disconnect, ['claude-code', '--yes']);
    const after = JSON.parse(readFileSync(claudeFile(), 'utf8'));
    assert.equal(after.theme, 'dark');
    assert.equal(after.env.OTEL_LOGS_EXPORT_INTERVAL, '1000');
    assert.equal(after.env.OTEL_LOG_USER_PROMPTS, '1', 'previous value restored');
    assert.equal(after.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, undefined);
    assert.equal(after.env.CLAUDE_CODE_ENABLE_TELEMETRY, undefined);
    assert.deepEqual(after.hooks, JSON.parse(CLAUDE_ORIGINAL).hooks);
  });

  test('refuses without a terminal or when the user says no', async () => {
    assert.equal((await call(connect, ['claude-code'], { answer: null })).code, 1);
    assert.equal((await call(connect, ['claude-code'], { answer: false })).code, 1);
    assert.equal(readFileSync(claudeFile(), 'utf8'), CLAUDE_ORIGINAL);
  });

  test('refuses an invalid settings file', async () => {
    writeFileSync(claudeFile(), '{ not json');
    const r = await call(connect, ['claude-code', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /not a JSON object/);
  });
});

describe('claude-code without a settings file', () => {
  test('connect creates it and disconnect removes it again', async () => {
    await call(connect, ['claude-code', '--yes']);
    assert.ok(existsSync(claudeFile()));
    await call(disconnect, ['claude-code', '--yes']);
    assert.equal(existsSync(claudeFile()), false);
  });
});

const CODEX_ORIGINAL = `model = "gpt-5.5-codex"

[otel]
metrics_exporter = "none"
environment = "work"

[projects."/tmp/x"]
trust_level = "trusted"
`;

describe('codex', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'codex'));
    writeFileSync(codexFile(), CODEX_ORIGINAL);
  });

  test('connect sets only snaglog keys inside [otel]', async () => {
    const r = await call(connect, ['codex', '--yes']);
    assert.equal(r.code, 0, r.err);
    assert.equal(
      readFileSync(codexFile(), 'utf8'),
      CODEX_ORIGINAL.replace(
        '[otel]\n',
        '[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }\n',
      ),
    );
    assert.match(r.out, /statsig/);
  });

  test('disconnect restores the original file byte for byte', async () => {
    await call(connect, ['codex', '--yes']);
    await call(disconnect, ['codex', '--yes']);
    assert.equal(readFileSync(codexFile(), 'utf8'), CODEX_ORIGINAL);
  });

  test('replaces an existing exporter, warns, and restores it on disconnect after edits', async () => {
    writeFileSync(codexFile(), `[otel]\nexporter = "none"\nlog_user_prompt = true\n`);
    const r = await call(connect, ['codex', '--yes']);
    assert.match(r.out, /log_user_prompt: true → false/);
    writeFileSync(codexFile(), `${readFileSync(codexFile(), 'utf8')}\n[tui]\nnotifications = true\n`);
    await call(disconnect, ['codex', '--yes']);
    assert.equal(readFileSync(codexFile(), 'utf8'), `[otel]\nexporter = "none"\nlog_user_prompt = true\n\n[tui]\nnotifications = true\n`);
  });

  test('refuses layouts it cannot edit safely', async () => {
    writeFileSync(codexFile(), 'otel.exporter = "none"\n');
    assert.equal((await call(connect, ['codex', '--yes'])).code, 1);
    writeFileSync(codexFile(), '[otel.exporter.otlp-http]\nendpoint = "x"\n');
    assert.equal((await call(connect, ['codex', '--yes'])).code, 1);
  });
});

describe('codex without a config file', () => {
  test('connect creates it and disconnect removes it again', async () => {
    await call(connect, ['codex', '--yes']);
    assert.match(readFileSync(codexFile(), 'utf8'), /^\[otel\]\n/);
    await call(disconnect, ['codex', '--yes']);
    assert.equal(existsSync(codexFile()), false);
  });
});

describe('arguments', () => {
  test('only loopback endpoints are accepted until team mode exists', async () => {
    const r = await call(connect, ['codex', '--endpoint', 'http://collector.example.com:4318', '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.err, /team mode/);
    assert.equal((await call(connect, ['codex', '--token', 'x'])).code, 2);
  });

  test('unsupported agents are named clearly', async () => {
    const r = await call(connect, ['chatgpt']);
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot be supported/);
  });

  test('disconnect without connect does nothing', async () => {
    const r = await call(disconnect, ['codex', '--yes']);
    assert.match(r.out, /not connected/);
  });
});

describe('skill-name hook', () => {
  test('reads the skill from a Skill tool call or an expanded slash command only', () => {
    assert.equal(skillNameFrom({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'deploy-preview' } }), 'deploy-preview');
    assert.equal(skillNameFrom({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { command: '/deploy-preview' } }), 'deploy-preview');
    assert.equal(skillNameFrom({ hook_event_name: 'UserPromptExpansion', command_name: 'deploy-preview' }), 'deploy-preview');
    assert.equal(skillNameFrom({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), undefined);
    assert.equal(skillNameFrom({ hook_event_name: 'UserPromptSubmit', prompt: '/deploy-preview now' }), undefined);
  });

  test('writes a hashed session id and the name, nothing else', () => {
    const home = join(dir, 'hookhome');
    record({ hook_event_name: 'PreToolUse', tool_name: 'Skill', session_id: 'raw-session', prompt: 'SECRET PROMPT', tool_input: { skill: 'deploy-preview', args: 'SECRET ARGS' } }, home);
    const text = readFileSync(join(home, 'hints', 'claude-code.jsonl'), 'utf8');
    const line = JSON.parse(text);
    assert.deepEqual(Object.keys(line).sort(), ['k', 's', 't']);
    assert.equal(line.k, 'deploy-preview');
    assert.equal(text.includes('raw-session') || text.includes('SECRET'), false);
  });
});
