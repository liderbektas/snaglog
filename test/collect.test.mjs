// Collector tests: snags via a fake gh, evals from a reconstructed
// `claude plugin eval` result file. Nothing reaches GitHub.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as collect } from '../cli/collect/index.mjs';
import { collectSnags } from '../cli/collect/snags.mjs';
import { collectEvals } from '../cli/collect/evals.mjs';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const RESULT = fileURLToPath(new URL('./fixtures/eval-aggregate-result.json', import.meta.url));
const HOOK = fileURLToPath(new URL('../cli/connect/hooks/claude-skill-hint.mjs', import.meta.url));

let dir;
let env;

function ghEnv(scenario) {
  return { ...env, PATH: process.env.PATH, SNAGLOG_GH: FAKE_GH, FAKE_GH_SCENARIO: JSON.stringify(scenario) };
}

function allStored() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf8'));
    }
  };
  if (existsSync(env.SNAGLOG_HOME)) walk(env.SNAGLOG_HOME);
  return out.join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-collect-'));
  env = { SNAGLOG_HOME: join(dir, 'home') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const labelled = [
  {
    number: 42,
    title: '[snag] deploy-preview: documented --env flag is rejected',
    state: 'OPEN',
    createdAt: '2026-11-01T10:00:00Z',
    closedAt: null,
    url: 'https://github.com/acme/skills/issues/42',
    labels: [{ name: 'skill-friction' }, { name: 'skill:deploy-preview' }],
    comments: [
      { body: 'Another occurrence of this snag was reported.\n\nSECRET BODY 1' },
      { body: 'Another occurrence of this snag was reported.\n\nSECRET BODY 2' },
      { body: 'I will look at this. SECRET HUMAN COMMENT' },
    ],
  },
  {
    number: 50,
    title: '[snag] db-migrate: dry run applies changes',
    state: 'CLOSED',
    createdAt: '2026-11-02T10:00:00Z',
    closedAt: '2026-11-05T10:00:00Z',
    url: 'https://github.com/acme/skills/issues/50',
    labels: [{ name: 'skill-friction' }, { name: 'skill:db-migrate' }],
    comments: [],
  },
];
const unlabelled = {
  number: 61,
  title: '[snag] lint-fix: fixer reports success but changes nothing',
  state: 'OPEN',
  createdAt: '2026-11-03T10:00:00Z',
  closedAt: null,
  url: 'https://github.com/acme/skills/issues/61',
  labels: [],
  comments: [],
};
const unrelated = { ...unlabelled, number: 70, title: 'Docs: what is a [snag]?' };

describe('snag collector', () => {
  test('merges labelled and unlabelled snags and counts repeat reports', () => {
    const { issues } = collectSnags('acme/skills', ghEnv({ labelIssues: labelled, issues: [unlabelled, unrelated, labelled[0]] }));
    assert.deepEqual(issues.map((i) => [i.number, i.skill, i.state, i.occurrences]), [
      [42, 'deploy-preview', 'open', 3],
      [50, 'db-migrate', 'closed', 1],
      [61, 'lint-fix', 'open', 1],
    ]);
  });

  test('stores no issue or comment bodies', () => {
    collectSnags('acme/skills', ghEnv({ labelIssues: labelled, issues: [] }));
    const file = join(env.SNAGLOG_HOME, 'collected', 'snags', 'acme__skills.json');
    assert.ok(existsSync(file));
    assert.equal(allStored().includes('SECRET'), false);
  });

  test('`snaglog collect` remembers repos and reports gh failures', async () => {
    const out = [];
    const err = [];
    const io = { out: (s) => out.push(s), err: (s) => err.push(s) };
    assert.equal(await collect(['--repo', 'acme/skills', '--path', dir], io, { env: ghEnv({ labelIssues: labelled, issues: [] }) }), 0);
    assert.match(out.join('\n'), /acme\/skills: 2 snags \(1 open\)/);
    assert.deepEqual(JSON.parse(readFileSync(join(env.SNAGLOG_HOME, 'config.json'), 'utf8')).repos, ['acme/skills']);
    assert.equal(await collect(['--path', dir], io, { env: ghEnv({ listFails: true }) }), 1);
    assert.match(err.join('\n'), /gh issue list failed/);
  });
});

function skillsRepo() {
  const root = join(dir, 'repo');
  const write = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write('skills/deploy-preview/SKILL.md', '---\nname: deploy-preview\ndescription: d\n---\n');
  write('skills/db-migrate/SKILL.md', '---\nname: db-migrate\ndescription: d\n---\n');
  write('evals/deploy-preview/golden/prompt.md', '---\nname: deploy-preview-golden\ntags: [skill:deploy-preview, golden]\n---\nDo it.\n');
  write('evals/deploy-preview/snag-42/prompt.md', '---\nname: snag-42-missing-flag\n---\nDo it.\n');
  write('evals/db-migrate/basic/case.yaml', 'schema_version: "1.1"\nname: db-migrate-basic\n');
  write('evals/db-migrate/inactive/prompt.md.example', '---\nname: ignored\n---\n');
  mkdirSync(join(root, 'evals', 'results', '2026-11-20T10-00-00'), { recursive: true });
  copyFileSync(RESULT, join(root, 'evals', 'results', '2026-11-20T10-00-00', 'aggregate-result.json'));
  return root;
}

describe('eval collector', () => {
  test('splits a run into per-skill summaries with allow-listed fields', () => {
    const root = skillsRepo();
    const written = collectEvals(root, env);
    assert.equal(written.length, 2);
    const read = (skill) => JSON.parse(readFileSync(written.find((p) => p.includes(`/evals/${skill}/`)), 'utf8'));
    const deploy = read('deploy-preview');
    assert.equal(deploy.score, 0.75);
    assert.equal(deploy.meanDelta, 0.35);
    assert.equal(deploy.costUsd, 0.2, 'half of the run cost: 2 of 4 cases');
    assert.deepEqual(deploy.cases.map((c) => [c.name, c.errored]), [['deploy-preview-golden', false], ['snag-42-missing-flag', true]]);
    assert.equal(read('db-migrate').score, 1);
    assert.equal(allStored().includes('SECRET'), false, 'no prompts, transcripts, explanations or error text');
  });

  test('imports each result once', () => {
    const root = skillsRepo();
    assert.equal(collectEvals(root, env).length, 2);
    assert.equal(collectEvals(root, env).length, 0);
  });

  test('skips result files with an unknown schema version', () => {
    const root = skillsRepo();
    const file = join(root, 'evals', 'results', '2026-11-20T10-00-00', 'aggregate-result.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), schemaVersion: 2 }));
    assert.equal(collectEvals(root, env).length, 0);
  });
});

describe('skill-name hook as a process', () => {
  test('prints nothing and exits 0, even on bad input', () => {
    const home = join(dir, 'hookhome');
    for (const input of [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Skill', session_id: 's', tool_input: { skill: 'x' } }), 'not json', '']) {
      const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { PATH: process.env.PATH, SNAGLOG_HOME: home } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
    assert.equal(readFileSync(join(home, 'hints', 'claude-code.jsonl'), 'utf8').trim().split('\n').length, 1);
  });
});
