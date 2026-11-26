// Thin wrapper around the official GitHub CLI. `SNAGLOG_GH` points at a
// different executable; the test suite uses it to substitute a fake that
// never touches the network.

import { spawnSync } from 'node:child_process';

export function gh(args, { env = process.env, input } = {}) {
  const r = spawnSync(env.SNAGLOG_GH || 'gh', args, {
    input,
    encoding: 'utf8',
    env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Read-only: is gh installed, logged in, and can it see the repo? */
export function ghCheck(repo, env = process.env) {
  if (gh(['--version'], { env }).missing) return { ok: false, reason: 'gh is not installed' };
  if (!gh(['auth', 'status'], { env }).ok) return { ok: false, reason: 'gh is not logged in (run `gh auth login`)' };
  if (!gh(['repo', 'view', repo, '--json', 'nameWithOwner'], { env }).ok) {
    return { ok: false, reason: `cannot access ${repo} with the current gh account` };
  }
  return { ok: true };
}

export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
