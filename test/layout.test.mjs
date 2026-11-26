// Projects that keep skills in .claude/skills (not a dedicated skills repo),
// and projects with no skills yet. gh and claude are faked.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as init } from '../cli/init.mjs';
import { run as evalCmd } from '../cli/eval.mjs';
import { collectEvals } from '../cli/collect/evals.mjs';
import { repoSkills, skillChanges } from '../cli/dashboard/data.mjs';
import { detectLayout } from '../cli/lib/layout.mjs';
import { listCases } from '../cli/lib/eval-cases.mjs';
import { checkCase, newCase } from '../skills/fix-snags/scripts/fix-pr.mjs';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);

let dir;
let app;
let env;
let claudeLog;

const io = () => {
  const out = [];
  return { io: { out: (s) => out.push(s), err: (s) => out.push(s) }, text: () => out.join('\n') };
};

function write(rel, text) {
  mkdirSync(join(app, rel, '..'), { recursive: true });
  writeFileSync(join(app, rel), text);
}

function git(...args) {
  const r = spawnSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-layout-'));
  app = join(dir, 'my-app');
  claudeLog = join(dir, 'claude.jsonl');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{}\n');
  git('init', '-q', '-b', 'main');
  env = { PATH: process.env.PATH, SNAGLOG_HOME: join(dir, 'home'), SNAGLOG_GH: FAKE_GH, SNAGLOG_CLAUDE: FAKE_CLAUDE, FAKE_GH_SCENARIO: '{}', FAKE_CLAUDE_LOG: claudeLog };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a project with .claude/skills', () => {
  beforeEach(() => {
    write('.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploy the app.\n---\n\n1. Run the deploy script.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  test('is detected as a project with .claude as the plugin root', () => {
    assert.deepEqual(detectLayout(app), { kind: 'project', pluginRoot: join(app, '.claude'), skillsDir: join(app, '.claude', 'skills'), evalsDir: join(app, '.claude', 'evals'), evalsRel: '.claude/evals' });
  });

  test('init puts bundled skills next to the project skill and evals under .claude/evals', async () => {
    const o = io();
    assert.equal(await init(['--repo', 'ayse/my-app', '--path', app, '--yes'], o.io, { env }), 0, o.text());
    assert.ok(existsSync(join(app, '.claude/skills/log-snag/SKILL.md')));
    assert.ok(existsSync(join(app, '.claude/skills/fix-snags/scripts/fix-pr.mjs')));
    assert.ok(existsSync(join(app, '.claude/evals/deploy/README.md')));
    assert.equal(existsSync(join(app, 'skills')), false);
    assert.equal(existsSync(join(app, 'evals')), false);
    assert.equal(readFileSync(join(app, '.gitignore'), 'utf8'), '.claude/evals/results/\n');
    assert.match(readFileSync(join(app, '.claude/skills/deploy/SKILL.md'), 'utf8'), /snaglog-repo: ayse\/my-app/);
  });

  test('eval targets the .claude folder and records the skill commit', async () => {
    write('.claude/evals/deploy/golden/prompt.md', '---\nname: deploy-golden\ntags: [skill:deploy, golden]\n---\nDeploy.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'eval case');
    const o = io();
    const code = await evalCmd(['--path', app, '--yes'], o.io, { env: { ...env, FAKE_CLAUDE_SCENARIO: JSON.stringify({ cases: [{ name: 'deploy-golden', score: 1 }] }) } });
    assert.equal(code, 0, o.text());
    const [args] = readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(args.slice(0, 3), ['plugin', 'eval', join(app, '.claude')]);
    assert.match(o.text(), /deploy: score 100%/);
  });

  test('eval names the .claude/evals folder when only examples exist', async () => {
    write('.claude/evals/deploy/example-case/prompt.md.example', '---\nname: deploy-example\n---\nDeploy.\n');
    const o = io();
    await evalCmd(['deploy', '--path', app, '--yes'], o.io, { env });
    assert.match(o.text(), /no active eval cases in \.claude\/evals\/deploy\//);
    assert.equal(existsSync(claudeLog), false, 'claude was not run');
  });

  test('collect imports results from .claude/evals/results', () => {
    write('.claude/evals/deploy/golden/prompt.md', '---\nname: deploy-golden\n---\nDeploy.\n');
    write('.claude/evals/results/2026-11-26T10-00-00/aggregate-result.json', JSON.stringify({ schemaVersion: 1, costUsd: 0.1, cases: [{ name: 'deploy-golden', aggregates: { score: 0.5 } }] }));
    assert.equal(collectEvals(app, env).length, 1);
  });

  test('fix-snags creates and checks cases under .claude/evals', () => {
    const created = newCase({ root: app, skill: 'deploy', issue: 3, slug: 'env flag' });
    assert.equal(created.created, join(app, '.claude/evals/deploy/snag-3-env-flag'));
    assert.equal(listCases(app).get('deploy')[0].category, 'real-usage');
    assert.equal(checkCase({ root: app, skill: 'deploy', issue: 3 }).ok, false, 'TODOs remain');
  });

  test('the dashboard finds the skill and its SKILL.md history', () => {
    assert.deepEqual(repoSkills(app), ['deploy']);
    assert.equal(skillChanges(app, 'deploy').length, 1);
  });
});

describe('a project without skills', () => {
  test('init adds log-snag and fix-snags to .claude/skills and says why', async () => {
    const o = io();
    assert.equal(await init(['--repo', 'ayse/my-app', '--path', app, '--yes'], o.io, { env }), 0, o.text());
    assert.match(o.text(), /no skills found; log-snag and fix-snags will be added to \.claude\/skills\//);
    assert.ok(existsSync(join(app, '.claude/skills/log-snag/SKILL.md')));
    assert.equal(existsSync(join(app, 'skills')), false);
  });
});

describe('a dedicated skills repo is unchanged', () => {
  test('a root-level skills/ folder keeps evals/ at the root', async () => {
    write('skills/count-lines/SKILL.md', '---\nname: count-lines\ndescription: d\n---\n');
    assert.equal(detectLayout(app).kind, 'skills-repo');
    await init(['--repo', 'ayse/skills', '--path', app, '--yes'], io().io, { env });
    assert.ok(existsSync(join(app, 'evals/count-lines/README.md')));
    assert.ok(existsSync(join(app, 'skills/log-snag/SKILL.md')));
    assert.equal(readFileSync(join(app, '.gitignore'), 'utf8'), 'evals/results/\n');
  });
});
