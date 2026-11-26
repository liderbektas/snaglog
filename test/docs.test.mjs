// Keeps the documentation honest: every snaglog command shown in README.md
// and CONTRIBUTING.md exists, every flag it uses is one the command accepts,
// and every local link or image points to a file in the repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, main } from '../cli/snaglog.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'docs/AGENT-ADAPTERS.md', 'docs/ECOSYSTEM.md', 'docs/GETTING-STARTED.md', 'docs/E2E-TRIAL.md'];

function commandLines(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const lines = [];
  for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const trimmed = line.trim();
      if (/^(snaglog|node cli\/snaglog\.mjs)\b/.test(trimmed)) lines.push(trimmed.replace(/^node cli\/snaglog\.mjs/, 'snaglog'));
    }
  }
  return lines;
}

async function help(command) {
  const out = [];
  await main([command, '--help'], { out: (s) => out.push(s), err: (s) => out.push(s) });
  return out.join('\n');
}

test('every documented snaglog command and flag exists', async () => {
  const lines = ['README.md', 'CONTRIBUTING.md', 'docs/GETTING-STARTED.md'].flatMap(commandLines);
  assert.ok(lines.length >= 10, 'found the documented commands');
  for (const line of lines) {
    const [, command, ...rest] = line.split(/\s+/);
    if (command.startsWith('-')) continue; // snaglog --help
    assert.ok(COMMANDS[command], `${line}: unknown command "${command}"`);
    const usage = await help(command);
    for (const token of rest.filter((t) => t.startsWith('--'))) {
      assert.ok(usage.includes(token.split('=')[0]), `${line}: "${token}" is not in \`snaglog ${command} --help\``);
    }
  }
});

test('local links and images in the docs point to existing files', () => {
  for (const file of DOCS) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = join(ROOT, dirname(file), target.split('#')[0]);
      assert.ok(existsSync(path), `${file}: broken link ${target}`);
    }
  }
});
