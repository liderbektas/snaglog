// Snag collector: read snag issues from a skills repo with `gh` (read-only)
// and keep only the fields the dashboard needs. Issue and comment bodies are
// read in memory to count repeat reports but are never stored.

import { join } from 'node:path';
import { gh } from '../lib/gh.mjs';
import { snaglogHome, writeJson } from '../lib/home.mjs';

const FIELDS = 'number,title,state,createdAt,closedAt,labels,url,comments';
const TITLE = /^\[snag\] ([A-Za-z0-9][A-Za-z0-9:_.-]*): /;
const REPEAT = /^Another occurrence of this snag was reported\./;

function list(repo, extra, env) {
  const r = gh(['issue', 'list', '--repo', repo, '--state', 'all', '--json', FIELDS, '--limit', '1000', ...extra], { env });
  if (!r.ok) throw new Error(`gh issue list failed for ${repo}: ${r.stderr.trim() || 'unknown error'}`);
  return JSON.parse(r.stdout);
}

export function skillOf(issue) {
  const label = (issue.labels ?? []).map((l) => l.name).find((n) => typeof n === 'string' && n.startsWith('skill:'));
  if (label) return label.slice('skill:'.length);
  return TITLE.exec(issue.title ?? '')?.[1];
}

export function summarize(issue) {
  const repeats = (issue.comments ?? []).filter((c) => REPEAT.test(String(c.body ?? ''))).length;
  return {
    number: issue.number,
    title: issue.title,
    skill: skillOf(issue) ?? 'unknown',
    state: String(issue.state ?? '').toLowerCase(),
    createdAt: issue.createdAt,
    closedAt: issue.closedAt || null,
    occurrences: 1 + repeats,
    url: issue.url,
  };
}

/** Collect labelled snags plus unlabelled ones (filed when labels were missing). */
export function collectSnags(repo, env = process.env) {
  const byNumber = new Map();
  for (const issue of list(repo, ['--label', 'skill-friction'], env)) byNumber.set(issue.number, issue);
  for (const issue of list(repo, ['--search', '"[snag]" in:title'], env)) {
    if (TITLE.test(issue.title ?? '')) byNumber.set(issue.number, issue);
  }
  const issues = [...byNumber.values()].map(summarize).sort((a, b) => a.number - b.number);
  const result = { repo, collectedAt: new Date().toISOString(), issues };
  writeJson(join(snaglogHome(env), 'collected', 'snags', `${repo.replace('/', '__')}.json`), result);
  return result;
}
