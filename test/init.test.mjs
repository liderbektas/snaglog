// Tests for `snaglog init`. A sample skills repo is created in a temp dir and
// `gh` is replaced by test/fixtures/fake-gh.mjs, so nothing reaches GitHub.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../cli/init.mjs';
import { appendReminder, setMetadataKey, SNAG_REMINDER } from '../cli/lib/skills.mjs';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const PACKAGE_LOG_SNAG = fileURLToPath(new URL('../skills/log-snag/', import.meta.url));
const REPO = 'acme/skills';

const DEPLOY = `---
# Deploys a preview environment.
name: deploy-preview
description: >
  Deploy a preview of the current branch.
  key: looks like yaml but is folded text
allowed-tools: [Bash, Read]
metadata:
  author: "platform-team"   # owner
  version: "1.2.0"
license: MIT
---

# Deploy preview

1. Run the deploy script with --env staging.
`;

const MIGRATE = ['---', 'name: db-migrate', 'description: Run database migrations.', '---', '', '# DB migrate', ''].join('\r\n');
const LINT = `---\nname: lint-fix\ndescription: Fix lint errors.\nmetadata: {}\n---\n\nBody.`;
const INLINE = `---\nname: inline-meta\ndescription: Inline metadata.\nmetadata: { author: someone }\n---\n\nBody.\n`;
const NO_FRONTMATTER = `# Not a real skill\n`;

let dir;
let log;

function write(rel, content) {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function snapshot() {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path !== log) out[relative(dir, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function ghCalls() {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args);
}

const labelCreates = () => ghCalls().filter((a) => a[0] === 'label' && a[1] === 'create').map((a) => a[2]);

async function init(args, { scenario = {}, answer = true } = {}) {
  const out = [];
  const err = [];
  const code = await run(['--repo', REPO, '--path', dir, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, {
    env: { PATH: process.env.PATH, SNAGLOG_GH: FAKE_GH, FAKE_GH_LOG: log, FAKE_GH_SCENARIO: JSON.stringify(scenario) },
    confirm: async () => answer,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snaglog-init-'));
  log = join(dir, '..', `${relative(tmpdir(), dir)}-gh.jsonl`);
  write('skills/deploy-preview/SKILL.md', DEPLOY);
  write('skills/db-migrate/SKILL.md', MIGRATE);
  write('skills/lint-fix/SKILL.md', LINT);
  write('skills/inline-meta/SKILL.md', INLINE);
  write('skills/broken/SKILL.md', NO_FRONTMATTER);
  write('README.md', '# skills\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(log, { force: true });
});

describe('dry run', () => {
  test('shows every planned change and changes nothing', async () => {
    const before = snapshot();
    const r = await init(['--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(labelCreates(), []);
    for (const expected of [
      'skills/deploy-preview/SKILL.md  add metadata.snaglog-repo: acme/skills',
      'append the snag reminder line',
      'skills/log-snag/',
      'evals/deploy-preview/',
      '.gitignore',
      'create label skill-friction',
      'create label skill:deploy-preview',
      'Dry run: nothing was changed.',
    ]) {
      assert.ok(r.out.includes(expected), `missing "${expected}" in:\n${r.out}`);
    }
    assert.match(r.out, /warning: skills\/broken\/SKILL\.md: no frontmatter/);
    assert.match(r.out, /warning: skills\/inline-meta\/SKILL\.md: metadata is written inline/);
  });
});

describe('real run', () => {
  test('adds the repo key without disturbing existing frontmatter', async () => {
    assert.equal((await init(['--yes'])).code, 0);
    const text = readFileSync(join(dir, 'skills/deploy-preview/SKILL.md'), 'utf8');
    assert.equal(
      text,
      DEPLOY.replace('  version: "1.2.0"\n', '  version: "1.2.0"\n  snaglog-repo: acme/skills\n').replace(/\n$/, '') + `\n\n${SNAG_REMINDER}\n`,
    );
  });

  test('keeps CRLF line endings and handles metadata: {}', async () => {
    await init(['--yes']);
    const migrate = readFileSync(join(dir, 'skills/db-migrate/SKILL.md'), 'utf8');
    assert.equal(migrate, ['---', 'name: db-migrate', 'description: Run database migrations.', 'metadata:', '  snaglog-repo: acme/skills', '---', '', '# DB migrate', '', SNAG_REMINDER, ''].join('\r\n'));
    const lint = readFileSync(join(dir, 'skills/lint-fix/SKILL.md'), 'utf8');
    assert.match(lint, /^---\nname: lint-fix\ndescription: Fix lint errors\.\nmetadata:\n {2}snaglog-repo: acme\/skills\n---\n/);
  });

  test('leaves files it cannot safely edit untouched', async () => {
    await init(['--yes']);
    assert.equal(readFileSync(join(dir, 'skills/inline-meta/SKILL.md'), 'utf8'), INLINE);
    assert.equal(readFileSync(join(dir, 'skills/broken/SKILL.md'), 'utf8'), NO_FRONTMATTER);
  });

  test('copies the bundled log-snag skill byte for byte, keeping the executable bit', async () => {
    await init(['--yes']);
    for (const rel of ['SKILL.md', 'scripts/file-snag.mjs']) {
      assert.equal(readFileSync(join(dir, 'skills/log-snag', rel), 'utf8'), readFileSync(join(PACKAGE_LOG_SNAG, rel), 'utf8'));
    }
    // Byte-for-byte equality above also proves bundled skills are not rewired.
    assert.ok(statSync(join(dir, 'skills/log-snag/scripts/file-snag.mjs')).mode & 0o100);
  });

  test('creates inactive eval skeletons that claude plugin eval will not run', async () => {
    await init(['--yes']);
    const files = Object.keys(snapshot()).filter((p) => p.startsWith('evals/deploy-preview/')).sort();
    assert.deepEqual(files, [
      'evals/deploy-preview/README.md',
      'evals/deploy-preview/example-case/graders/uses-skill.md.example',
      'evals/deploy-preview/example-case/prompt.md.example',
    ]);
    assert.match(readFileSync(join(dir, 'evals/deploy-preview/example-case/prompt.md.example'), 'utf8'), /tags: \[skill:deploy-preview, golden\]/);
    assert.equal(existsSync(join(dir, 'evals/broken')), false);
  });

  test('keeps eval results out of git and creates the labels', async () => {
    await init(['--yes']);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'evals/results/\n');
    assert.deepEqual(labelCreates().sort(), ['skill-friction', 'skill:db-migrate', 'skill:deploy-preview', 'skill:inline-meta', 'skill:lint-fix']);
  });

  test('only creates labels that are missing', async () => {
    await init(['--yes'], { scenario: { labels: ['skill-friction', 'skill:deploy-preview'] } });
    assert.deepEqual(labelCreates().sort(), ['skill:db-migrate', 'skill:inline-meta', 'skill:lint-fix']);
  });

  test('running twice gives the same result and the second run does nothing', async () => {
    await init(['--yes']);
    const first = snapshot();
    const created = labelCreates();
    const second = await init(['--yes'], { scenario: { labels: created } });
    assert.equal(second.code, 0);
    assert.match(second.out, /Nothing to do/);
    assert.deepEqual(snapshot(), first);
    assert.equal(labelCreates().length, created.length, 'no new label calls');
  });

  test('updates a snaglog-repo that points elsewhere and says so', async () => {
    write('skills/deploy-preview/SKILL.md', DEPLOY.replace('license: MIT', 'license: MIT').replace('  version: "1.2.0"\n', '  version: "1.2.0"\n  snaglog-repo: old/place\n'));
    const r = await init(['--dry-run']);
    assert.match(r.out, /change metadata\.snaglog-repo: old\/place → acme\/skills/);
  });
});

describe('approval', () => {
  test('refuses to apply without a terminal and without --yes', async () => {
    const before = snapshot();
    const r = await init([], { answer: null });
    assert.equal(r.code, 1);
    assert.match(r.err, /no terminal to confirm/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(labelCreates(), []);
  });

  test('changes nothing when the user says no', async () => {
    const before = snapshot();
    const r = await init([], { answer: false });
    assert.match(r.out, /Cancelled/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(labelCreates(), []);
  });
});

describe('GitHub problems', () => {
  test('without gh login, local changes still apply and labels are skipped with a warning', async () => {
    const r = await init(['--yes'], { scenario: { auth: false } });
    assert.equal(r.code, 0);
    assert.match(r.out, /labels not checked: gh is not logged in/);
    assert.deepEqual(labelCreates(), []);
    assert.match(readFileSync(join(dir, 'skills/db-migrate/SKILL.md'), 'utf8'), /snaglog-repo/);
  });

  test('a failed label creation is reported and the exit code is 1', async () => {
    const r = await init(['--yes'], { scenario: { labelCreateFails: true } });
    assert.equal(r.code, 1);
    assert.match(r.err, /failed: create label skill-friction/);
  });
});

describe('arguments', () => {
  test('requires a valid --repo', async () => {
    const err = [];
    assert.equal(await run(['--repo', 'not a repo'], { out() {}, err: (s) => err.push(s) }), 2);
    assert.equal(await run([], { out() {}, err() {} }), 2);
  });
});

describe('frontmatter editing', () => {
  test('matches the indentation of an existing metadata block', () => {
    const r = setMetadataKey('---\nname: x\nmetadata:\n    author: a\n---\n', 'snaglog-repo', 'o/r');
    assert.equal(r.text, '---\nname: x\nmetadata:\n    author: a\n    snaglog-repo: o/r\n---\n');
  });

  test('reports unchanged when the key already has the value', () => {
    assert.equal(setMetadataKey('---\nmetadata:\n  snaglog-repo: "o/r"\n---\n', 'snaglog-repo', 'o/r').action, 'unchanged');
  });

  test('the reminder is appended once', () => {
    const once = appendReminder('---\nname: x\n---\n\nBody\n\n\n').text;
    assert.equal(once, `---\nname: x\n---\n\nBody\n\n${SNAG_REMINDER}\n`);
    assert.equal(appendReminder(once).action, 'unchanged');
  });
});
