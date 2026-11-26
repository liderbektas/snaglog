// Read-only loaders for everything the dashboard shows. All data comes from
// ~/.snaglog (or SNAGLOG_HOME) and, for SKILL.md history, from `git log` in
// the skills repo checkout. Nothing here writes or touches the network.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/home.mjs';
import { BUNDLED_SKILLS, findSkills } from '../lib/skills.mjs';

function jsonLines(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a partially written line
    }
  }
  return out;
}

export function loadEvents(home) {
  const dir = join(home, 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => jsonLines(join(dir, f)))
    .filter((e) => e && typeof e.skill === 'string' && typeof e.time === 'string');
}

export function loadSnags(home) {
  const dir = join(home, 'collected', 'snags');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const data = readJson(join(dir, f), {});
      return (data.issues ?? []).map((issue) => ({ ...issue, repo: data.repo }));
    });
}

export function loadEvals(home) {
  const out = new Map();
  const dir = join(home, 'evals');
  if (!existsSync(dir)) return out;
  for (const skill of readdirSync(dir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const records = readdirSync(join(dir, skill.name))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(dir, skill.name, f), undefined))
      .filter((r) => r && typeof r.ranAt === 'string')
      .sort((a, b) => a.ranAt.localeCompare(b.ranAt));
    if (records.length) out.set(skill.name, records);
  }
  return out;
}

/** Local snag reports; `line` is the record's position in snags.jsonl. */
export function loadLocalReports(home) {
  return jsonLines(join(home, 'snags.jsonl')).map((r, line) => ({ ...r, line }));
}

export function loadConnections(home) {
  return readJson(join(home, 'connections.json'), {});
}

/** Skill names found in the checkout's skills/ folder (bundled ones excluded). */
export function repoSkills(root) {
  if (!root || !existsSync(join(root, 'skills'))) return [];
  return findSkills(join(root, 'skills')).filter((s) => !BUNDLED_SKILLS.includes(s.name)).map((s) => s.name);
}

/** Commits that changed skills/<skill>/SKILL.md, newest first. */
export function skillChanges(root, skill) {
  if (!root || !existsSync(join(root, 'skills', skill, 'SKILL.md'))) return [];
  const r = spawnSync('git', ['-C', root, 'log', '--format=%H%x09%cI%x09%s', '--', join('skills', skill, 'SKILL.md')], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, date, ...subject] = line.split('\t');
      return { commit, date, subject: subject.join('\t') };
    });
}
