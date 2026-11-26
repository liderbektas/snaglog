// Tests for skills/log-snag/scripts/file-snag.mjs.
// Every test uses a fake `gh` (test/fixtures/fake-gh.mjs) and a temporary
// SNAGLOG_HOME, so nothing reaches GitHub or the real ~/.snaglog.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize, titleSimilarity, parseFrontmatter, buildIssue, LIMITS } from '../skills/log-snag/scripts/file-snag.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/log-snag/scripts/file-snag.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
chmodSync(FAKE_GH, 0o755);

let dir;
let home;
let log;

function skillDir({ repo = 'acme/skills', name = 'deploy-preview' } = {}) {
  const path = join(dir, 'skills', name);
  mkdirSync(path, { recursive: true });
  const meta = repo ? `metadata:\n  snaglog-repo: ${repo}\n  version: "1.2.0"\n` : '';
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Deploys previews.\n${meta}---\n\nBody.\n`);
  return path;
}

function draft(overrides = {}) {
  const report = {
    skill: 'deploy-preview',
    skillDir: 'skillDir' in overrides ? overrides.skillDir : skillDir(),
    agent: 'claude-code',
    model: 'test-model',
    trigger: 'rejected-flag',
    summary: 'documented --env flag is rejected',
    attempted: 'Ran the deploy script with --env staging as step 3 instructs.',
    expected: 'A preview deployment for staging.',
    actual: "error: unknown option '--env'",
    workaround: 'Used --target staging instead.',
    ...overrides,
  };
  const file = join(dir, `snag-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(report));
  return file;
}

function run(args, { scenario = {}, env = {} } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    // Built from scratch on purpose: no inherited CI, SNAGLOG_REPO or GH_TOKEN.
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      SNAGLOG_HOME: home,
      SNAGLOG_GH: FAKE_GH,
      FAKE_GH_LOG: log,
      FAKE_GH_SCENARIO: JSON.stringify(scenario),
      ...env,
    },
  });
  return { code: r.status, out: r.stdout ? safeJson(r.stdout) : undefined, err: r.stderr };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ghCalls() {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const writes = () => ghCalls().filter((c) => c.args[0] === 'issue' && (c.args[1] === 'create' || c.args[1] === 'comment'));

function localRecords() {
  const file = join(home, 'snags.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-test-'));
  home = join(dir, '.snaglog');
  log = join(dir, 'gh-calls.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('approval flow', () => {
  test('prepare only runs read-only gh commands and returns a token', () => {
    const r = run(['prepare', draft()]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.title, '[snag] deploy-preview: documented --env flag is rejected');
    assert.match(r.out.approval, /^[0-9a-f]{12}$/);
    assert.deepEqual(r.out.target, { repo: 'acme/skills', source: 'metadata.snaglog-repo', visibility: 'private' });
    assert.deepEqual(ghCalls().map((c) => c.args.slice(0, 2).join(' ')), ['--version', 'auth status', 'repo view']);
  });

  test('approved submit files exactly the previewed text with both labels', () => {
    const file = draft();
    const preview = run(['prepare', file]).out;
    const r = run(['submit', file, '--approve', preview.approval]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.status, 'filed');
    assert.equal(r.out.url, 'https://github.com/acme/skills/issues/101');
    const [create] = writes();
    assert.deepEqual(create.args.slice(0, 9), ['issue', 'create', '--repo', 'acme/skills', '--title', preview.title, '--body-file', '-', '--label']);
    assert.ok(create.args.includes('skill-friction'));
    assert.ok(create.args.includes('skill:deploy-preview'));
    assert.equal(create.stdin, preview.body);
    assert.equal(existsSync(file), false, 'draft is deleted after filing');
  });

  test('a token that does not match is refused and nothing is filed or saved', () => {
    const r = run(['submit', draft(), '--approve', '000000000000']);
    assert.equal(r.code, 3);
    assert.equal(writes().length, 0);
    assert.equal(localRecords().length, 0);
  });

  test('editing the report after approval invalidates the token', () => {
    const file = draft();
    const { approval } = run(['prepare', file]).out;
    const report = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...report, expected: 'Something else entirely.' }));
    assert.equal(run(['submit', file, '--approve', approval]).code, 3);
    assert.equal(writes().length, 0);
  });
});

describe('rejection', () => {
  test('save-local --reason rejected keeps a sanitized record and never calls gh', () => {
    const file = draft();
    const r = run(['save-local', file, '--reason', 'rejected']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.status, 'saved-local');
    assert.equal(r.out.reason, 'rejected');
    assert.equal(ghCalls().length, 0);
    const [record] = localRecords();
    assert.equal(record.status, 'unsent');
    assert.equal(record.skill, 'deploy-preview');
    assert.equal(record.repo, 'acme/skills');
    assert.match(record.body, /documented|unknown option/);
    assert.equal(existsSync(file), false);
  });
});

describe('unattended runs', () => {
  for (const env of [{ SNAGLOG_UNATTENDED: '1' }, { CI: 'true' }]) {
    test(`never files when ${Object.keys(env)[0]} is set`, () => {
      const file = draft();
      const preview = run(['prepare', file], { env });
      assert.equal(preview.out.willSaveLocal, 'unattended');
      assert.equal(preview.out.approval, undefined);
      const r = run(['submit', file, '--approve', 'anything'], { env });
      assert.equal(r.out.status, 'saved-local');
      assert.equal(r.out.reason, 'unattended');
      assert.equal(ghCalls().length, 0, 'no gh call at all');
    });
  }
});

describe('duplicates', () => {
  test('comments on an open issue with a similar title instead of opening a new one', () => {
    const issues = [
      { number: 3, title: '[snag] other-skill: documented --env flag is rejected', url: 'u3' },
      { number: 7, title: '[snag] deploy-preview: --env flag rejected by deploy script', url: 'u7' },
    ];
    const file = draft();
    const { approval } = run(['prepare', file], { scenario: { issues } }).out;
    const r = run(['submit', file, '--approve', approval], { scenario: { issues } });
    assert.equal(r.out.status, 'commented');
    assert.equal(r.out.number, 7);
    const calls = writes();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ['issue', 'comment', '7']);
    assert.match(calls[0].stdin, /^Another occurrence/);
  });

  test('opens a new issue when no open issue is similar enough', () => {
    const issues = [{ number: 9, title: '[snag] deploy-preview: preview URL missing from output', url: 'u9' }];
    const file = draft();
    const { approval } = run(['prepare', file], { scenario: { issues } }).out;
    const r = run(['submit', file, '--approve', approval], { scenario: { issues } });
    assert.equal(r.out.status, 'filed');
  });

  test('title similarity ignores stop words and punctuation', () => {
    assert.ok(titleSimilarity('documented --env flag is rejected', '--env flag rejected by deploy script') >= 0.5);
    assert.ok(titleSimilarity('documented --env flag is rejected', 'preview URL missing from output') < 0.5);
  });
});

describe('local fallback', () => {
  const cases = [
    ['gh is not installed', { env: { SNAGLOG_GH: '/nonexistent/gh' } }, 'gh-missing'],
    ['gh is not logged in', { scenario: { auth: false } }, 'gh-not-authenticated'],
    ['the repo is not accessible', { scenario: { repo: { exists: false } } }, 'no-access'],
    ['issues are disabled', { scenario: { repo: { hasIssuesEnabled: false } } }, 'issues-disabled'],
  ];
  for (const [name, options, reason] of cases) {
    test(`keeps the report locally when ${name}`, () => {
      const file = draft();
      const preview = run(['prepare', file], options);
      assert.equal(preview.out.willSaveLocal, reason);
      assert.equal(preview.out.approval, undefined, 'no token when nothing can be filed');
      const r = run(['save-local', file, '--reason', reason], options);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out.status, 'saved-local');
      assert.equal(r.out.reason, reason);
      assert.equal(writes().length, 0);
      assert.equal(localRecords()[0].reason, reason);
    });
  }

  test('falls back locally when gh breaks between prepare and submit', () => {
    const file = draft();
    const { approval } = run(['prepare', file]).out;
    const r = run(['submit', file, '--approve', approval], { scenario: { auth: false } });
    assert.equal(r.out.status, 'saved-local');
    assert.equal(r.out.reason, 'gh-not-authenticated');
    assert.equal(writes().length, 0);
  });

  test('suggests gh auth login only the first time', () => {
    const options = { scenario: { auth: false } };
    const once = run(['save-local', draft(), '--reason', 'gh-not-authenticated'], options);
    assert.match(once.out.hint, /gh auth login/);
    assert.equal(run(['save-local', draft(), '--reason', 'gh-not-authenticated'], options).out.hint, undefined);
  });

  test('rejects an unknown save-local reason', () => {
    assert.equal(run(['save-local', draft(), '--reason', 'whatever']).code, 2);
  });

  test('keeps the report locally without any gh call when no target repo is known', () => {
    const file = draft({ skillDir: skillDir({ repo: null }) });
    assert.equal(run(['prepare', file]).out.willSaveLocal, 'no-target');
    assert.equal(run(['submit', file, '--approve', 'x'], { env: {} }).out.reason, 'no-target');
    assert.equal(ghCalls().length, 0);
  });

  test('falls back to SNAGLOG_REPO when the skill has no metadata.snaglog-repo', () => {
    const file = draft({ skillDir: skillDir({ repo: null }) });
    const preview = run(['prepare', file], { env: { SNAGLOG_REPO: 'acme/fallback' } }).out;
    assert.deepEqual(preview.target, { repo: 'acme/fallback', source: 'SNAGLOG_REPO', visibility: 'private' });
  });

  test('a failed create keeps the report locally', () => {
    const options = { scenario: { createFails: true } };
    const file = draft();
    const { approval } = run(['prepare', file], options).out;
    const r = run(['submit', file, '--approve', approval], options);
    assert.equal(r.out.reason, 'gh-error');
    assert.equal(localRecords().length, 1);
  });

  test('files without labels when the repo does not have them', () => {
    const options = { scenario: { labelsMissing: true } };
    const file = draft();
    const { approval } = run(['prepare', file], options).out;
    const r = run(['submit', file, '--approve', approval], options);
    assert.equal(r.out.status, 'filed');
    assert.equal(r.out.labelsOmitted, true);
    const creates = writes();
    assert.equal(creates.length, 2);
    assert.equal(creates[1].args.includes('--label'), false);
  });
});

describe('masking', () => {
  const samples = {
    'github-token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github-token (fine-grained)': 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'gitlab-token': 'glpat-abcdefghijklmnopqrst',
    'anthropic-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'openai-key': 'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'stripe-key': 'sk_live_abcdefghijklmnop1234',
    'aws-access-key-id': 'AKIAIOSFODNN7EXAMPLE',
    'slack-token': 'xoxb-1234567890-abcdefghij',
    'google-api-key': `AIza${'A'.repeat(35)}`,
    'npm-token': `npm_${'a'.repeat(36)}`,
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'private-key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  };
  for (const [type, secret] of Object.entries(samples)) {
    test(`masks ${type}`, () => {
      const { text } = sanitize(`value: ${secret} end`);
      assert.equal(text.includes(secret), false, text);
      assert.match(text, /\[REDACTED/);
    });
  }

  test('masks headers, URL credentials, assignments, emails, IPs and home paths', () => {
    const input = [
      'curl -H "Authorization: Bearer abc123def456"',
      'git clone https://bob:hunter2@git.example.com/x.git',
      'DB_PASSWORD=supersecret',
      'contact alice@example.com',
      'host 10.20.30.40 and 127.0.0.1',
      'see /Users/alice/work/app.js and /home/bob/x',
    ].join('\n');
    const { text, counts } = sanitize(input);
    for (const leaked of ['abc123def456', 'hunter2', 'supersecret', 'alice@example.com', '10.20.30.40', '/Users/alice', '/home/bob']) {
      assert.equal(text.includes(leaked), false, `${leaked} leaked: ${text}`);
    }
    assert.match(text, /127\.0\.0\.1/);
    assert.match(text, /~\/work\/app\.js/);
    assert.deepEqual(Object.keys(counts).sort(), ['auth-header', 'email', 'home-path', 'ip-address', 'secret-assignment', 'url-credentials']);
  });

  test('masks before truncating, so a secret across the length limit cannot leak', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const attempted = `${'x '.repeat((LIMITS.field - 10) / 2)}${secret}`;
    const { body } = buildIssue({ skill: 'deploy-preview', summary: 's', attempted, expected: 'e', actual: 'a' }, {});
    assert.equal(body.includes('ghp_'), false);
  });

  test('secrets never reach GitHub or the local file', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const file = draft({ actual: `fatal: auth failed for token ${secret}`, attempted: 'ran it as alice@example.com' });
    const { approval, redactions } = run(['prepare', file]).out;
    assert.equal(redactions['github-token'], 1);
    run(['submit', file, '--approve', approval]);
    const [create] = writes();
    assert.equal(create.stdin.includes(secret), false);
    assert.equal(create.stdin.includes('alice@example.com'), false);

    const local = draft({ actual: `token ${secret}` });
    run(['save-local', local, '--reason', 'rejected']);
    assert.equal(readFileSync(join(home, 'snags.jsonl'), 'utf8').includes(secret), false);
  });
});

describe('report shape', () => {
  test('keeps at most 20 lines of output and notes the rest', () => {
    const actual = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { body } = buildIssue({ skill: 'deploy-preview', summary: 's', attempted: 'a', expected: 'e', actual }, {});
    assert.match(body, /line 20\n/);
    assert.equal(body.includes('line 21'), false);
    assert.match(body, /10 more lines omitted/);
  });

  test('output containing backticks cannot break out of its code block', () => {
    const { body } = buildIssue({ skill: 'deploy-preview', summary: 's', attempted: 'a', expected: 'e', actual: '```\n# injected heading\n```' }, {});
    assert.match(body, /````text\n```\n# injected heading\n```\n````/);
  });

  test('mentions are neutralised so a report cannot ping people', () => {
    const { body } = buildIssue({ skill: 'deploy-preview', summary: 's', attempted: 'asked @octocat', expected: 'e', actual: 'a' }, {});
    assert.match(body, /`@octocat`/);
  });

  test('rejects an invalid skill name before doing anything', () => {
    const r = run(['prepare', draft({ skill: 'Bad Name; rm -rf' })]);
    assert.equal(r.code, 2);
    assert.equal(ghCalls().length, 0);
  });

  test('rejects a skill name that does not match its SKILL.md', () => {
    const r = run(['prepare', draft({ skill: 'other-skill' })]);
    assert.equal(r.code, 2);
    assert.match(r.err, /does not match/);
  });

  test('rejects a missing required field', () => {
    assert.equal(run(['prepare', draft({ expected: '' })]).code, 2);
  });

  test('reads metadata from frontmatter without disturbing other keys', () => {
    const fm = parseFrontmatter('---\nname: x\ndescription: >\n  folded: text\nmetadata:\n  snaglog-repo: "acme/skills"\n  version: 1.0 # comment\n---\n');
    assert.deepEqual(fm.metadata, { 'snaglog-repo': 'acme/skills', version: '1.0' });
    assert.equal(fm.name, 'x');
  });
});
