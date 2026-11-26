// OTLP receiver and adapter tests. Fixtures in test/fixtures/otel/ are
// reconstructed from official docs/source (see their _provenance field) and
// deliberately contain SECRET-* values that must never reach disk.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createReceiver } from '../cli/collect/otel/receiver.mjs';
import { anonymize, salt } from '../cli/lib/home.mjs';
import { SkillTracker } from '../cli/collect/otel/tracker.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/otel/${name}.json`, import.meta.url), 'utf8'));
const CLAUDE_SESSION = '00000000-0000-4000-8000-000000000001';
const CODEX_SESSION = '00000000-0000-4000-8000-000000000002';
const T = 1764150000000;

let home;
let env;

function storedText() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(readFileSync(path, 'utf8'));
    }
  };
  if (existsSync(home)) walk(home);
  return out.join('\n');
}

function storedEvents() {
  const dir = join(home, 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
}

function writeHint(session, t, skill) {
  mkdirSync(join(home, 'hints'), { recursive: true });
  writeFileSync(join(home, 'hints', 'claude-code.jsonl'), `${JSON.stringify({ t, s: anonymize(session, salt(env)), k: skill })}\n`, { flag: 'a' });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'snaglog-otel-'));
  env = { SNAGLOG_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('claude-code adapter', () => {
  test('turns a skill session into invoked, tool, error and completed events', () => {
    writeHint(CLAUDE_SESSION, T + 1200, 'deploy-preview');
    const { events } = createReceiver({ env }).ingest(fixture('claude-code-skill-session'));
    assert.deepEqual(events.map((e) => e.kind), ['invoked', 'error', 'error', 'tool_call', 'completed']);
    assert.ok(events.every((e) => e.skill === 'deploy-preview' && e.agent === 'claude-code'));
    assert.equal(events.at(-1).time, new Date(T + 9000).toISOString(), 'closed by assistant_response at the end of the turn');
    const done = events.at(-1);
    assert.equal(done.success, false);
    assert.equal(done.retries, 1, 'the second failing Bash call is a retry');
    assert.equal(done.tokens, 10500, 'input + output + cache tokens');
    assert.equal(done.costUsd, 0.02);
    assert.equal(done.durationMs, 8000);
    assert.equal(done.model, 'claude-opus-5-5');
  });

  test('tool calls after the next prompt are not attributed to the skill', () => {
    writeHint(CLAUDE_SESSION, T + 1200, 'deploy-preview');
    const { events } = createReceiver({ env }).ingest(fixture('claude-code-skill-session'));
    assert.equal(events.filter((e) => e.time >= new Date(T + 60000).toISOString()).length, 0);
  });

  test('without a hook hint the redacted name stays "custom_skill"', () => {
    const { events } = createReceiver({ env }).ingest(fixture('claude-code-skill-session'));
    assert.ok(events.every((e) => e.skill === 'custom_skill'));
  });

  test('a hint from another session or too far away in time is not used', () => {
    writeHint('another-session', T + 1200, 'wrong-a');
    writeHint(CLAUDE_SESSION, T + 5 * 60 * 1000, 'wrong-b');
    const { events } = createReceiver({ env }).ingest(fixture('claude-code-skill-session'));
    assert.equal(events[0].skill, 'custom_skill');
  });
});

describe('claude-code adapter on a captured session', () => {
  // test/fixtures/otel/claude-code-captured-slash.json is a real, anonymised
  // capture: `/demo-snag` typed by the user, stopped at the first API call.
  const captured = () => fixture('claude-code-captured-slash');
  const withRedactedApiName = () => {
    const doc = captured();
    for (const rl of doc.resourceLogs) for (const sl of rl.scopeLogs) for (const lr of sl.logRecords) {
      const name = lr.attributes.find((a) => a.key === 'skill.name');
      if (name) name.value.stringValue = 'custom_skill';
    }
    return doc;
  };

  test('takes the real name from api_error when no hook hint exists', () => {
    const { events } = createReceiver({ env }).ingest(captured());
    assert.deepEqual(events.map((e) => [e.kind, e.skill]), [['invoked', 'demo-snag']]);
  });

  test('matches the captured hook input by prompt id', async () => {
    const { record } = await import('../cli/connect/hooks/claude-skill-hint.mjs');
    const hookInput = JSON.parse(readFileSync(new URL('./fixtures/claude-hook-captured-expansion.json', import.meta.url), 'utf8'));
    assert.equal(record(hookInput, home), true);
    const { events } = createReceiver({ env }).ingest(withRedactedApiName());
    assert.deepEqual(events.map((e) => [e.kind, e.skill]), [['invoked', 'demo-snag']]);
  });

  test('without hint or api name the window is still counted as custom_skill', () => {
    const receiver = createReceiver({ env, now: () => Date.parse('2030-01-01T00:00:00Z') });
    const first = receiver.ingest(withRedactedApiName()).events;
    assert.deepEqual(first, [], 'held back while the name may still arrive');
    const swept = receiver.sweep();
    assert.deepEqual(swept.map((e) => [e.kind, e.skill]), [['invoked', 'custom_skill'], ['completed', 'custom_skill']]);
  });

  test('full capture: proactive and slash-command runs of a broken skill', () => {
    const { events } = createReceiver({ env }).ingest(fixture('claude-code-captured-skill'));
    const runs = [events.slice(0, 4), events.slice(4)];
    for (const run of runs) {
      assert.deepEqual(run.map((e) => e.kind), ['invoked', 'error', 'tool_call', 'completed']);
      assert.ok(run.every((e) => e.skill === 'demo-snag'));
      const done = run.at(-1);
      assert.equal(done.model, 'claude-opus-5-5', 'the model is known from the first API call on');
      assert.equal(done.success, false, 'the documented flag failed');
      assert.ok(done.tokens > 0 && done.costUsd > 0);
    }
    assert.notEqual(runs[0][0].sessionId, runs[1][0].sessionId);
  });

  test('full capture: the captured Skill-tool hook input names the skill by prompt id', async () => {
    const { record } = await import('../cli/connect/hooks/claude-skill-hint.mjs');
    const hookInput = JSON.parse(readFileSync(new URL('./fixtures/claude-hook-captured-skill-tool.json', import.meta.url), 'utf8'));
    assert.equal(record(hookInput, home), true);
    const doc = fixture('claude-code-captured-skill');
    for (const rl of doc.resourceLogs) for (const sl of rl.scopeLogs) for (const lr of sl.logRecords) {
      const name = lr.attributes.find((a) => a.key === 'skill.name');
      if (name) name.value.stringValue = 'custom_skill';
    }
    const { events } = createReceiver({ env }).ingest(doc);
    assert.equal(events[0].skill, 'demo-snag', 'proactive run named by the hook');
    assert.equal(events[4].skill, 'custom_skill', 'the slash run had no PreToolUse hook in this capture');
  });

  test('stores no identifiers from the capture', () => {
    createReceiver({ env }).ingest(captured());
    const text = storedText();
    assert.equal(/00000000-0000-4000-8000/.test(text), false);
    assert.equal(text.includes('REDACTED'), false);
  });
});

describe('codex adapter', () => {
  test('uses codex.skill_invocation and attributes tool results and tokens', () => {
    const { events } = createReceiver({ env }).ingest(fixture('codex-skill-session'));
    assert.deepEqual(events.map((e) => e.kind), ['invoked', 'error', 'tool_call', 'completed']);
    assert.ok(events.every((e) => e.skill === 'deploy-preview' && e.agent === 'codex' && e.model === 'gpt-5.5-codex'));
    assert.equal(events.at(-1).tokens, 1000);
  });
});

describe('privacy', () => {
  test('prompt text, tool input/output, errors and identities never reach disk', () => {
    writeHint(CLAUDE_SESSION, T + 1200, 'deploy-preview');
    const receiver = createReceiver({ env });
    receiver.ingest(fixture('claude-code-skill-session'));
    receiver.ingest(fixture('codex-skill-session'));
    const text = storedText();
    assert.ok(storedEvents().length > 0);
    assert.equal(text.includes('SECRET'), false, 'no SECRET-* value is stored');
    for (const raw of [CLAUDE_SESSION, CODEX_SESSION, 'deploy my app', '/Users/alice']) assert.equal(text.includes(raw), false, raw);
  });

  test('stored events contain only SkillEvent fields', () => {
    writeHint(CLAUDE_SESSION, T + 1200, 'deploy-preview');
    createReceiver({ env }).ingest(fixture('claude-code-skill-session'));
    const allowed = new Set(['time', 'agent', 'model', 'skill', 'kind', 'durationMs', 'success', 'tokens', 'costUsd', 'sessionId', 'retries']);
    for (const event of storedEvents()) for (const key of Object.keys(event)) assert.ok(allowed.has(key), key);
  });

  test('unexpected skill names are stored as "unknown"', () => {
    const doc = fixture('codex-skill-session');
    const attrs = doc.resourceLogs[0].scopeLogs[0].logRecords[1].attributes;
    attrs.find((a) => a.key === 'skill.name').value.stringValue = '<script>alert(1)</script>';
    const { events } = createReceiver({ env }).ingest(doc);
    assert.equal(events[0].skill, 'unknown');
  });
});

describe('tracker', () => {
  test('idle windows are closed by sweep', () => {
    const tracker = new SkillTracker('x', { idleMs: 1000 });
    tracker.open('s', { skill: 'k', time: new Date(0).toISOString() });
    assert.deepEqual(tracker.sweep(500), []);
    assert.equal(tracker.sweep(5000)[0].kind, 'completed');
  });

  test('a new skill in the same session closes the previous one', () => {
    const tracker = new SkillTracker('x');
    tracker.open('s', { skill: 'a', time: new Date(0).toISOString() });
    const events = tracker.open('s', { skill: 'b', time: new Date(1000).toISOString() });
    assert.deepEqual(events.map((e) => `${e.skill}:${e.kind}`), ['a:completed', 'b:invoked']);
  });
});

describe('HTTP receiver', () => {
  let receiver;
  let port;

  beforeEach(async () => {
    receiver = createReceiver({ env });
    ({ port } = await receiver.listen(0));
  });
  afterEach(() => receiver.close());

  function post(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: headers.method ?? 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  test('listens on 127.0.0.1 only', () => {
    assert.equal(receiver.server.address().address, '127.0.0.1');
  });

  test('accepts OTLP JSON logs, plain or gzip', async () => {
    const body = JSON.stringify(fixture('codex-skill-session'));
    assert.equal((await post('/v1/logs', body)).status, 200);
    assert.equal((await post('/v1/logs', gzipSync(body), { 'content-encoding': 'gzip' })).status, 200);
    assert.equal(storedEvents().filter((e) => e.kind === 'invoked').length, 2);
  });

  test('acknowledges metrics and traces without storing them', async () => {
    assert.equal((await post('/v1/metrics', '{"resourceMetrics":[]}')).status, 200);
    assert.equal((await post('/v1/traces', '{"resourceSpans":[]}')).status, 200);
    assert.equal(storedEvents().length, 0);
  });

  test('rejects protobuf loudly instead of dropping it silently', async () => {
    const r = await post('/v1/logs', 'binary', { 'content-type': 'application/x-protobuf' });
    assert.equal(r.status, 415);
    assert.match(r.body, /http\/json/);
  });

  test('rejects non-loopback Host headers (DNS rebinding)', async () => {
    assert.equal((await post('/v1/logs', '{}', { host: 'evil.example.com' })).status, 403);
  });

  test('rejects other methods, paths, bad JSON and oversized bodies', async () => {
    assert.equal((await post('/v1/logs', undefined, { method: 'GET' })).status, 405);
    assert.equal((await post('/v1/other', '{}')).status, 404);
    assert.equal((await post('/v1/logs', '{not json')).status, 400);
    // A body over the limit is refused: either a 413 or the connection is cut.
    const big = await post('/v1/logs', 'x'.repeat(6 * 1024 * 1024)).catch((error) => ({ status: error.code }));
    assert.ok([413, 'EPIPE', 'ECONNRESET'].includes(big.status), String(big.status));
    assert.equal(storedEvents().length, 0);
  });

  test('records when each agent was last seen', async () => {
    await post('/v1/logs', JSON.stringify(fixture('codex-skill-session')));
    const connections = JSON.parse(readFileSync(join(home, 'connections.json'), 'utf8'));
    assert.match(connections.codex.lastEventAt, /^\d{4}-/);
  });
});
