// `snaglog eval` tests. `claude` is replaced by test/fixtures/fake-claude.mjs,
// so no model is called and nothing costs money.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalArgs, FORBIDDEN_FLAGS, run } from '../cli/eval.mjs';
import { estimateCost, listCases } from '../cli/lib/eval-cases.mjs';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);

let dir;
let repo;
let home;
let log;

function write(rel, text) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

function git(...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function prompt(name, tags) {
  return `---\nname: ${name}\ntags: [${tags.join(', ')}]\nruns: 3\n---\n\nDo the thing.\n`;
}

const PASSING = [{ name: 'deploy-golden', score: 1, delta: 0.5 }, { name: 'snag-42', score: 0.5, delta: 0.2 }];

async function evalCmd(args, { scenario = {}, answer = true } = {}) {
  const out = [];
  const err = [];
  const code = await run(['--path', repo, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, {
    env: { PATH: process.env.PATH, SNAGLOG_HOME: home, SNAGLOG_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCENARIO: JSON.stringify({ cases: PASSING, ...scenario }) },
    confirm: async () => answer,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const records = (skill) => {
  const d = join(home, 'evals', skill);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : [];
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-eval-test-'));
  repo = join(dir, 'repo');
  home = join(dir, 'home');
  log = join(dir, 'claude-calls.jsonl');
  write('skills/deploy-preview/SKILL.md', '---\nname: deploy-preview\ndescription: d\n---\nBody\n');
  write('skills/db-migrate/SKILL.md', '---\nname: db-migrate\ndescription: d\n---\nBody\n');
  write('skills/log-snag/SKILL.md', '---\nname: log-snag\ndescription: bundled\n---\n');
  write('evals/deploy-preview/golden/prompt.md', prompt('deploy-golden', ['skill:deploy-preview', 'golden']));
  write('evals/deploy-preview/golden/graders/uses-skill.md', '---\ntype: tool_used\ntool: Skill\n---\n');
  write('evals/deploy-preview/snag-42/case.yaml', 'schema_version: "1.1"\nname: snag-42\ntags:\n  - skill:deploy-preview\n  - real-usage\n');
  write('evals/db-migrate/example-case/prompt.md.example', prompt('ignored', ['skill:db-migrate']));
  write('.gitignore', 'evals/results/\n');
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('safety of the claude call', () => {
  test('always passes --no-publish and never a forbidden flag', () => {
    for (const ablate of [true, false]) {
      const args = evalArgs({ root: '/r', skill: 's', ablate, maxCostUsd: 1, jsonPath: '/t/r.json', outputDir: '/t/out' });
      assert.ok(args.includes('--no-publish'));
      for (const flag of FORBIDDEN_FLAGS) assert.equal(args.includes(flag), false, flag);
    }
  });

  test('the exact argument list sent to claude', async () => {
    await evalCmd(['deploy-preview', '--yes', '--ablate', '--max-cost-usd', '0.5', '--runs', '1']);
    const [args] = calls();
    const json = args[args.indexOf('--json') + 1];
    const out = args[args.indexOf('--output-dir') + 1];
    assert.deepEqual(args, [
      'plugin', 'eval', repo, '--tag', 'skill:deploy-preview', '--ablation', 'with-without', '--no-publish',
      '--json', json, '--output-dir', out, '--max-cost-usd', '0.5', '--runs', '1',
    ]);
    assert.equal(existsSync(json), false, 'full result (with prompts) is deleted');
    assert.equal(existsSync(out), false, 'full report is deleted');
  });
});

describe('trust', () => {
  test('--trust-plugin is passed only after the user confirms trust; --yes does not confirm it', async () => {
    const answers = [];
    const out = [];
    const run2 = (args, answer) => run(['--path', repo, ...args], { out: (s) => out.push(s), err: (s) => out.push(s) }, {
      env: { PATH: process.env.PATH, SNAGLOG_HOME: home, SNAGLOG_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCENARIO: JSON.stringify({ cases: PASSING }) },
      confirm: async (q) => { answers.push(q); return answer; },
    });
    assert.equal(await run2(['--yes', '--trust-plugin'], null), 1, 'no terminal: refused');
    assert.equal(await run2(['--yes', '--trust-plugin'], false), 1, 'declined: refused');
    assert.equal(calls().length, 0);
    assert.match(answers[0], /Trust [\s\S]*run its eval suite on this machine as you/);
    assert.equal(await run2(['--yes', '--trust-plugin'], true), 0);
    assert.ok(calls()[0].includes('--trust-plugin'));
    await run2(['--yes', '--all'], true);
    assert.equal(calls()[1].includes('--trust-plugin'), false, 'never passed without the option');
  });
});

describe('plan and confirmation', () => {
  test('dry run shows cases, mix, estimate and ceiling and runs nothing', async () => {
    const r = await evalCmd(['--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.out, /deploy-preview: 2 cases \(1 golden, 1 real-usage, 0 owner-reviewed\); estimate unknown; stops at \$1\.00/);
    assert.match(r.out, /Hard ceiling: \$1\.00/);
    assert.match(r.out, /cost money|billed/);
    assert.equal(calls().length, 0);
  });

  test('a skill without active cases is not selected; the .example stays inactive', async () => {
    const r = await evalCmd(['--dry-run', '--all']);
    assert.equal(r.out.includes('db-migrate:'), false);
    assert.deepEqual([...listCases(repo).keys()], ['deploy-preview']);
  });

  test('nothing runs without a terminal, or when the user says no', async () => {
    assert.equal((await evalCmd([], { answer: null })).code, 1);
    assert.equal((await evalCmd([], { answer: false })).code, 1);
    assert.equal(calls().length, 0);
    assert.deepEqual(records('deploy-preview'), []);
  });

  test('warns about cases missing the skill tag', async () => {
    write('evals/deploy-preview/untagged/prompt.md', prompt('untagged-case', ['golden']));
    const r = await evalCmd(['--dry-run']);
    assert.match(r.out, /untagged-case lack the tag skill:deploy-preview/);
  });

  test('refuses an outdated Claude Code before asking', async () => {
    const r = await evalCmd(['--yes'], { scenario: { version: '2.1.200' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /2\.1\.269 or later/);
    assert.equal(calls().length, 0);
  });
});

describe('recording', () => {
  test('stores an allow-listed summary with the skill commit', async () => {
    const r = await evalCmd(['--yes']);
    assert.equal(r.code, 0, r.err);
    const [entry] = records('deploy-preview');
    assert.equal(entry.score, 0.75);
    assert.equal(entry.costUsd, 0.12);
    assert.equal(entry.commit, git('log', '-1', '--format=%H'));
    assert.equal(entry.dirty, false);
    assert.equal(entry.ablation, false);
    assert.equal(entry.allPassed, false);
    const stored = readdirSync(join(home, 'evals', 'deploy-preview')).map((f) => readFileSync(join(home, 'evals', 'deploy-preview', f), 'utf8')).join('');
    assert.equal(stored.includes('SECRET'), false);
    assert.match(r.out, /deploy-preview: score 75%, cost \$0\.12, commit [0-9a-f]{7}/);
  });

  test('marks uncommitted changes and warns when every case passes', async () => {
    write('skills/deploy-preview/SKILL.md', '---\nname: deploy-preview\ndescription: changed\n---\n');
    const r = await evalCmd(['--yes'], { scenario: { cases: [{ name: 'deploy-golden', score: 1 }, { name: 'snag-42', score: 1 }] } });
    const [entry] = records('deploy-preview');
    assert.equal(entry.dirty, true);
    assert.equal(entry.allPassed, true);
    assert.match(r.out, /every case passed/);
  });

  test('by default only skills that changed since their last eval run', async () => {
    await evalCmd(['--yes']);
    const second = await evalCmd(['--yes']);
    assert.match(second.out, /no skill changed/);
    assert.equal(calls().length, 1);
    write('evals/deploy-preview/new/prompt.md', prompt('new-case', ['skill:deploy-preview', 'owner-reviewed']));
    await evalCmd(['--yes']);
    assert.equal(calls().length, 2);
  });

  test('the next estimate comes from the last recorded cost', async () => {
    await evalCmd(['--yes']);
    const r = await evalCmd(['--all', '--dry-run', '--ablate']);
    assert.match(r.out, /estimate ~\$0\.24/, 'per-case cost × 2 cases × 2 for the baseline');
  });

  test('a partial run (cost ceiling) is recorded as partial', async () => {
    await evalCmd(['--yes'], { scenario: { exit: 2, partial: true } });
    assert.equal(records('deploy-preview')[0].partial, true);
  });

  test('no result file means a failed run and nothing is recorded', async () => {
    const r = await evalCmd(['--yes'], { scenario: { noResult: true, exit: 1 } });
    assert.equal(r.code, 1);
    assert.match(r.err, /produced no result/);
    assert.deepEqual(records('deploy-preview'), []);
  });

  test('--keep-report keeps the report in the git-ignored results folder only', async () => {
    await evalCmd(['--yes', '--keep-report']);
    const results = readdirSync(join(repo, 'evals', 'results'));
    assert.equal(results.length, 1);
    assert.equal(git('status', '--porcelain'), '', 'nothing new for git to commit');
  });
});

describe('estimates', () => {
  test('unknown without history, scaled by cases and ablation with it', () => {
    assert.equal(estimateCost(undefined, 3, false).usd, null);
    const last = { costUsd: 0.4, cases: [{}, {}], ablation: true };
    assert.equal(estimateCost(last, 3, true).usd.toFixed(2), '0.60');
    assert.equal(estimateCost(last, 3, false).usd.toFixed(2), '0.30');
  });
});

describe('arguments', () => {
  test('rejects bad values and unknown skills', async () => {
    assert.equal((await evalCmd(['--max-cost-usd', '0'])).code, 2);
    assert.equal((await evalCmd(['--runs', '99'])).code, 2);
    assert.equal((await evalCmd(['nope'])).code, 2);
    assert.equal((await evalCmd(['deploy-preview', '--all'])).code, 2);
  });
});
