// Eval cases in snaglog's layout for `claude plugin eval`:
//   <evals dir>/<skill>/<case>/prompt.md   (or case.yaml) + graders/*.md
// where <evals dir> is evals/ in a skills repo and .claude/evals/ in a
// project (see layout.mjs).
// Inactive `.example` files are ignored, as Claude Code ignores them.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter } from '../../skills/log-snag/scripts/file-snag.mjs';
import { detectLayout } from './layout.mjs';

export const CATEGORIES = ['golden', 'real-usage', 'owner-reviewed'];
const RESERVED = new Set(['results', 'mocks']);

function parseTags(text, isYaml) {
  if (!isYaml) {
    const raw = parseFrontmatter(text).tags;
    if (typeof raw === 'string') return raw.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const flow = /^tags:\s*\[([^\]]*)\]/m.exec(text);
  if (flow) return flow[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const block = /^tags:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(text);
  if (block) return block[1].split('\n').map((l) => l.replace(/^[ \t]+-\s*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return [];
}

/** Map<skill, [{ name, dir, tags, category }]> for every active case. */
export function listCases(root) {
  const out = new Map();
  const evals = detectLayout(root).evalsDir;
  if (!existsSync(evals)) return out;
  for (const skill of readdirSync(evals, { withFileTypes: true })) {
    if (!skill.isDirectory() || RESERVED.has(skill.name)) continue;
    const cases = [];
    for (const kase of readdirSync(join(evals, skill.name), { withFileTypes: true })) {
      if (!kase.isDirectory()) continue;
      const dir = join(evals, skill.name, kase.name);
      const prompt = join(dir, 'prompt.md');
      const yaml = join(dir, 'case.yaml');
      let name = kase.name;
      let tags = [];
      if (existsSync(prompt)) {
        const text = readFileSync(prompt, 'utf8');
        const fm = parseFrontmatter(text);
        if (typeof fm.name === 'string' && fm.name) name = fm.name;
        tags = parseTags(text, false);
      } else if (existsSync(yaml)) {
        const text = readFileSync(yaml, 'utf8');
        name = /^name:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(text)?.[1] ?? name;
        tags = parseTags(text, true);
      } else continue;
      cases.push({ name, dir, tags, category: CATEGORIES.find((c) => tags.includes(c)) ?? null });
    }
    if (cases.length) out.set(skill.name, cases.sort((a, b) => a.name.localeCompare(b.name)));
  }
  return out;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && !RESERVED.has(entry.name)) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

/** Content hash of a skill and its eval cases: changes when either changes. */
export function fingerprint(root, skill) {
  const hash = createHash('sha256');
  const { skillsDir, evalsDir } = detectLayout(root);
  for (const file of [...filesUnder(join(skillsDir, skill)), ...filesUnder(join(evalsDir, skill))]) {
    hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** Newest stored eval record for a skill, or undefined. */
export function lastRecord(home, skill) {
  const dir = join(home, 'evals', skill);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files.reverse()) {
    try {
      const record = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (record && typeof record === 'object') return { ...record, file: join(dir, file), mtime: statSync(join(dir, file)).mtimeMs };
    } catch {
      // skip unreadable records
    }
  }
  return undefined;
}

/**
 * Estimate the cost of the next run from the last recorded one: cost per
 * case × current case count, doubled or halved when ablation changes.
 */
export function estimateCost(record, caseCount, ablate) {
  if (!record || typeof record.costUsd !== 'number' || !Array.isArray(record.cases) || record.cases.length === 0) {
    return { usd: null, basis: 'no previous run with a recorded cost' };
  }
  let perCase = record.costUsd / record.cases.length;
  if (ablate && !record.ablation) perCase *= 2;
  if (!ablate && record.ablation) perCase /= 2;
  return { usd: perCase * caseCount, basis: `last run (${record.ranAt?.slice(0, 10) ?? 'unknown date'})` };
}
