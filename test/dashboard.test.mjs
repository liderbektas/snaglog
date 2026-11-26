// Dashboard tests on generated sample data. gh is faked; nothing leaves the
// machine and no model is called.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDashboard } from '../cli/dashboard/server.mjs';
import { createSample } from '../cli/dashboard/sample.mjs';
import { compare, overview, skillDetail } from '../cli/dashboard/metrics.mjs';
import { loadEvals, loadEvents, loadLocalReports, loadSnags, skillChanges } from '../cli/dashboard/data.mjs';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
let dir;
let home;
let root;
let commits;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-dash-'));
  home = join(dir, 'home');
  root = join(dir, 'repo');
  ({ commits } = createSample({ home, root }));
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function start(options = {}) {
  const dash = createDashboard({ env: { PATH: process.env.PATH, SNAGLOG_HOME: home, SNAGLOG_GH: FAKE_GH, FAKE_GH_SCENARIO: '{}' }, root, ...options });
  const { port } = await dash.listen(0);
  const call = (path, { method = 'GET', body, headers = {}, token = dash.token } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { ...(token ? { 'x-snaglog-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  return { dash, call };
}

function data() {
  return { events: loadEvents(home), snags: loadSnags(home), evals: loadEvals(home), reports: loadLocalReports(home) };
}

describe('page', () => {
  test('is served from 127.0.0.1 with a strict CSP and no external resources', async () => {
    const { dash, call } = await start();
    try {
      assert.equal(dash.server.address().address, '127.0.0.1');
      const r = await call('/', { token: null });
      assert.equal(r.status, 200);
      assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-[^']+'; style-src 'nonce-[^']+'/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(r.text), false, 'no external src/href');
      assert.equal(/@import|url\(\s*["']?https?:/i.test(r.text), false, 'no external CSS');
      assert.equal(r.text.includes('__NONCE__') || r.text.includes('__CSRF__'), false);
      assert.ok(r.text.includes(dash.token), 'token embedded in the page');
    } finally {
      await dash.close();
    }
  });

  test('the inline script compiles', () => {
    const html = readFileSync(new URL('../cli/dashboard/index.html', import.meta.url), 'utf8');
    const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(html)[1];
    assert.doesNotThrow(() => new Script(script));
  });

  test('defines light and dark themes', () => {
    const html = readFileSync(new URL('../cli/dashboard/index.html', import.meta.url), 'utf8');
    assert.match(html, /:root\[data-theme="dark"\]/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /color-scheme: light/);
  });
});

describe('request checks', () => {
  test('non-loopback Host, missing token and foreign Origin are refused', async () => {
    const { dash, call } = await start();
    try {
      assert.equal((await call('/', { headers: { host: 'evil.example.com' }, token: null })).status, 403);
      assert.equal((await call('/api/overview', { token: null })).status, 403);
      assert.equal((await call('/api/overview', { token: 'wrong' })).status, 403);
      const cross = await call('/api/reports/00000000-0000-4000-8000-00000000d001', { method: 'DELETE', headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' } });
      assert.equal(cross.status, 403);
      assert.equal(loadLocalReports(home).length, 2, 'nothing deleted');
    } finally {
      await dash.close();
    }
  });
});

describe('the five pages', () => {
  test('overview: skills needing attention come first', async () => {
    const { dash, call } = await start();
    try {
      const { json } = await call('/api/overview');
      assert.deepEqual(json.rows.map((r) => r.skill), ['lint-fix', 'release-notes', 'deploy-preview', 'db-migrate']);
      const lint = json.rows[0];
      assert.ok(lint.attention.reasons.some((x) => x.startsWith('eval score fell')));
      assert.ok(lint.attention.reasons.some((x) => x.startsWith('error rate rising')));
      assert.ok(json.rows.find((r) => r.skill === 'db-migrate').attention.reasons.some((x) => x.includes('every eval case passes')));
    } finally {
      await dash.close();
    }
  });

  test('skill detail: charts data, agents, snags, evals and SKILL.md history', async () => {
    const { dash, call } = await start();
    try {
      const { json } = await call('/api/skill/release-notes');
      assert.equal(json.daily.length, 30);
      assert.deepEqual(json.byAgent.map((a) => a.agent), ['claude-code', 'codex']);
      assert.ok(json.warnings.some((w) => w.includes('worse in codex')));
      const deploy = (await call('/api/skill/deploy-preview')).json;
      assert.equal(deploy.evals.length, 2);
      assert.equal(deploy.changes.length, 2);
      assert.equal(deploy.snags.closed, 1);
      assert.equal((await call('/api/skill/%3Cscript%3E')).status, 400);
    } finally {
      await dash.close();
    }
  });

  test('before / after: the deploy-preview fix helped', async () => {
    const { dash, call } = await start();
    try {
      const { json } = await call(`/api/compare/deploy-preview/${commits.deployFix}`);
      assert.equal(json.verdict.result, 'improved');
      assert.ok(json.before.errorRate > 0.3 && json.after.errorRate < 0.15);
      assert.equal(json.before.evalScore, 0.5);
      assert.equal(json.after.evalScore, 0.83);
      assert.equal((await call('/api/compare/deploy-preview/deadbeef')).status, 404);
    } finally {
      await dash.close();
    }
  });

  test('unsent reports and connections are listed', async () => {
    const { dash, call } = await start();
    try {
      const { json } = await call('/api/reports');
      assert.equal(json.reports.length, 2);
      assert.match(json.reports[0].approval, /^[0-9a-f]{12}$/);
      assert.equal(json.reports[1].approval, null, 'no repo, so it cannot be sent yet');
      const conn = (await call('/api/connections')).json;
      assert.deepEqual(conn.agents.map((a) => [a.agent, a.connected]), [['claude-code', true], ['codex', true]]);
      assert.ok(conn.unsupported.some((u) => u.agent === 'chatgpt'));
    } finally {
      await dash.close();
    }
  });
});

describe('unsent report actions', () => {
  test('edits are masked again, sending needs the current approval, demo mode never sends', async () => {
    const id = '00000000-0000-4000-8000-00000000d001';
    const demo = await start({ demo: true });
    try {
      const { json } = await demo.call('/api/reports');
      const r = json.reports.find((x) => x.id === id);
      assert.equal((await demo.call(`/api/reports/${id}/send`, { method: 'POST', body: { approval: r.approval } })).status, 403);
    } finally {
      await demo.dash.close();
    }

    const { dash, call } = await start();
    try {
      const before = (await call('/api/reports')).json.reports.find((x) => x.id === id);
      const edited = await call(`/api/reports/${id}`, { method: 'PUT', body: { body: `${before.body}\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789` } });
      assert.equal(edited.status, 200, edited.text);
      assert.equal(edited.json.report.body.includes('ghp_'), false, 'secret masked on save');
      assert.equal((await call(`/api/reports/${id}/send`, { method: 'POST', body: { approval: before.approval } })).status, 409, 'stale approval');
      const sent = await call(`/api/reports/${id}/send`, { method: 'POST', body: { approval: edited.json.report.approval } });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(sent.json.sent.status, 'filed');
      assert.equal((await call('/api/reports')).json.reports.some((x) => x.id === id), false);

      const other = '00000000-0000-4000-8000-00000000d002';
      assert.equal((await call(`/api/reports/${other}/send`, { method: 'POST', body: { approval: 'x' } })).status, 400, 'no repo yet');
      assert.equal((await call(`/api/reports/${other}`, { method: 'PUT', body: { repo: 'not a repo' } })).status, 400);
      // Like the page: DELETE without a body (Node's client would send it chunked).
      assert.equal((await call(`/api/reports/${other}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 200);
      assert.equal((await call('/api/reports')).json.reports.length, 0);
    } finally {
      await dash.close();
    }
  });
});

describe('metrics', () => {
  test('compare reports not-enough-data right after a change', () => {
    const d = data();
    const changes = skillChanges(root, 'lint-fix');
    const result = compare('lint-fix', commits.lintChange, { ...d, changes, now: Date.parse(changes[0].date) + 60 * 1000 });
    assert.equal(result.verdict.result, 'not-enough-data');
  });

  test('overview and detail work without any data', () => {
    const empty = { events: [], snags: [], evals: new Map(), reports: [] };
    assert.deepEqual(overview(empty), []);
    assert.equal(skillDetail('x', empty).summary.invocations, 0);
  });
});

describe('small samples (end-to-end trial)', () => {
  test('few runs on each side give not-enough-data with the numbers as notes', () => {
    const at = Date.parse('2026-11-20T12:00:00Z');
    const ev = (t, kind) => ({ time: new Date(at + t * 60000).toISOString(), agent: 'claude-code', skill: 'count-lines', kind, sessionId: 's' });
    const events = [ev(-30, 'error'), ev(-20, 'error'), ev(-10, 'error'), ev(10, 'tool_call'), ev(20, 'tool_call')];
    const evals = new Map([['count-lines', [{ ranAt: new Date(at + 5 * 60000).toISOString(), score: 0.5, commit: 'abc1234' }]]]);
    const changes = [{ commit: 'abc1234', date: new Date(at).toISOString(), subject: 'fix' }];
    const r = compare('count-lines', 'abc1234', { events, snags: [], evals, changes, now: at + 60 * 60000 });
    assert.equal(r.verdict.result, 'not-enough-data');
    assert.ok(r.verdict.notes.some((n) => n.includes('100% → 0%') && n.includes('only 3 and 2 tool calls')));
    assert.ok(r.verdict.notes.some((n) => n.includes('eval score after the change: 50%')));
  });
});

describe('redesign data', () => {
  test('overview rows carry 14-day bars and last use; skill detail carries recent activity', () => {
    const d = data();
    const [row] = overview({ ...d, skills: ['deploy-preview'] }).filter((r) => r.skill === 'deploy-preview');
    assert.equal(row.daily14.length, 14);
    assert.ok(row.daily14.some((n) => n > 0));
    assert.match(row.lastUsedAt, /^\d{4}-/);
    const detail = skillDetail('deploy-preview', { ...d, changes: [] });
    assert.ok(detail.recent.length > 0 && detail.recent.length <= 40);
    assert.deepEqual(Object.keys(detail.recent[0]).sort(), ['agent', 'durationMs', 'kind', 'success', 'time']);
    assert.ok(detail.recent[0].time >= detail.recent.at(-1).time, 'newest first');
  });
});
