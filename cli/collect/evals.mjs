// Eval collector: import results written by Claude Code's official
// `claude plugin eval` (<evals dir>/results/<timestamp>/aggregate-result.json) and
// store one allow-listed summary per skill and run under
// ~/.snaglog/evals/<skill>/. Prompts, grader explanations and evidence in the
// result file are never copied.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson, snaglogHome, writeJson } from '../lib/home.mjs';
import { findSkills } from '../lib/skills.mjs';
import { listCases } from '../lib/eval-cases.mjs';
import { detectLayout } from '../lib/layout.mjs';

/** Map case name → skill from the evals/<skill>/<case>/ layout snaglog uses. */
export function caseSkills(root) {
  const map = new Map();
  for (const [skill, cases] of listCases(root)) for (const kase of cases) map.set(kase.name, skill);
  return map;
}

function resultFiles(root) {
  const dir = join(detectLayout(root).evalsDir, 'results');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'aggregate-result.json')))
    .map((d) => join(dir, d.name, 'aggregate-result.json'))
    .sort();
}

function commitBefore(file, when) {
  const r = spawnSync('git', ['-C', dirname(file), 'log', '-1', `--before=${when}`, '--format=%H', '--', basename(file)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turn one aggregate-result.json into per-skill summaries. Exported for tests. */
export function summarizeResult(result, { cases: caseMap, ranAt }) {
  const perSkill = new Map();
  for (const kase of Array.isArray(result?.cases) ? result.cases : []) {
    const name = String(kase?.name ?? '');
    const skill = caseMap.get(name);
    if (!skill) continue;
    const runs = Array.isArray(kase?.arms?.with) ? kase.arms.with : [];
    const entry = {
      name,
      score: num(kase?.aggregates?.score),
      delta: num(kase?.aggregates?.delta),
      errored: runs.some((r) => r?.error),
      aborted: runs.some((r) => r?.aborted),
    };
    if (!perSkill.has(skill)) perSkill.set(skill, []);
    perSkill.get(skill).push(entry);
  }
  const totalCases = Array.isArray(result?.cases) ? result.cases.length : 0;
  return [...perSkill].map(([skill, cases]) => {
    const scores = cases.map((c) => c.score).filter((s) => s !== null);
    const deltas = cases.map((c) => c.delta).filter((d) => d !== null);
    return {
      skill,
      ranAt,
      claudeVersion: typeof result?.claudeVersion === 'string' ? result.claudeVersion : null,
      partial: Boolean(result?.partial),
      score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      meanDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
      cases,
      // Cost is reported per run, not per skill: keep the share by case count.
      costUsd: num(result?.costUsd) !== null && totalCases ? (result.costUsd * cases.length) / totalCases : null,
      durationSeconds: num(result?.durationSeconds),
    };
  });
}

/** Import every not-yet-imported result in <evals dir>/results. */
export function collectEvals(root, env = process.env) {
  const home = snaglogHome(env);
  const indexFile = join(home, 'evals', 'imported.json');
  const imported = new Set(readJson(indexFile, []));
  const cases = caseSkills(root);
  const skills = new Map(findSkills(root).map((s) => [s.name, s.file]));
  const written = [];
  for (const file of resultFiles(root)) {
    const key = `${file}:${statSync(file).mtimeMs}`;
    if (imported.has(key)) continue;
    let result;
    try {
      result = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (result?.schemaVersion !== 1) continue; // unknown format: skip rather than guess
    const ranAt = new Date(statSync(file).mtimeMs).toISOString();
    for (const summary of summarizeResult(result, { cases, ranAt })) {
      const skillFile = skills.get(summary.skill);
      summary.commit = skillFile ? commitBefore(skillFile, ranAt) : null;
      const out = join(home, 'evals', summary.skill, `${ranAt.replace(/[:.]/g, '-')}.json`);
      writeJson(out, summary);
      written.push(out);
    }
    imported.add(key);
  }
  writeJson(indexFile, [...imported]);
  return written;
}
