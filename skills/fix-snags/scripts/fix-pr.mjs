#!/usr/bin/env node
// fix-pr.mjs — mechanical steps of the fix-snags skill.
//
//   node fix-pr.mjs new-case   --root <repo> --skill <name> --issue <N> --slug <words>
//   node fix-pr.mjs check-case --root <repo> --skill <name> --issue <N>
//   node fix-pr.mjs pr-body    --root <repo> --input <fix.json>
//   node fix-pr.mjs open-pr    --root <repo> --input <fix.json> --branch <name> --approve <token>
//
// fix.json, written by the agent:
//   { "repo": "owner/repo", "skill": "name", "title": "short summary",
//     "groups": [{ "summary": "...", "cause": "...", "change": "...", "issues": [42, 57], "cases": ["snag-42-env-flag"] }] }
//
// `pr-body` prints the exact title and body plus an approval token. `open-pr`
// refuses unless the token matches the same title, body, repo and branch,
// then pushes the branch and opens a pull request. Nothing here ever merges a
// pull request; merging is always the skill owner's decision.
//
// No npm dependencies: this file is copied into other repositories.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const TODO = 'TODO(fix-snags)';

export class FixError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function run(cmd, args, { env = process.env, input, cwd } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, cwd, env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } });
  if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function requireSkill(skill) {
  if (!SKILL_NAME.test(skill ?? '')) throw new FixError('--skill must be a skill name');
}

function requireIssue(issue) {
  const n = Number(issue);
  if (!Number.isInteger(n) || n < 1) throw new FixError('--issue must be an issue number');
  return n;
}

function caseDir(root, skill, issue) {
  const dir = join(root, 'evals', skill);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((d) => d.startsWith(`snag-${issue}-`) || d === `snag-${issue}`);
  return name ? join(dir, name) : undefined;
}

/** Create the eval case that reproduces snag #N (the agent then fills in the TODOs). */
export function newCase({ root, skill, issue, slug }) {
  requireSkill(skill);
  const n = requireIssue(issue);
  if (caseDir(root, skill, n)) throw new FixError(`an eval case for snag #${n} already exists: ${caseDir(root, skill, n)}`, 3);
  const name = `snag-${n}${slugify(slug) ? `-${slugify(slug)}` : ''}`;
  const dir = join(root, 'evals', skill, name);
  mkdirSync(join(dir, 'graders'), { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), `---
name: ${name}
description: Reproduces snag #${n} in the ${skill} skill.
tags: [skill:${skill}, real-usage, snag:${n}]
runs: 3
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

${TODO}: write the task from snag #${n} in general terms (no user prompt text,
no file contents), so that the agent uses the ${skill} skill and would hit the snag.
`);
  writeFileSync(join(dir, 'graders', 'uses-skill.md'), `---
type: tool_used
tool: Skill
arm: both
---
`);
  writeFileSync(join(dir, 'graders', 'no-snag.md'), `---
type: regex
target: trace
pattern: "${TODO}: a pattern that appears only when the snag happens"
match: not_contains
---
`);
  return { created: dir, name, files: ['prompt.md', 'graders/uses-skill.md', 'graders/no-snag.md'] };
}

/** Check that the case is filled in and tagged correctly. */
export function checkCase({ root, skill, issue }) {
  requireSkill(skill);
  const n = requireIssue(issue);
  const dir = caseDir(root, skill, n);
  if (!dir) return { ok: false, problems: [`no eval case for snag #${n} under evals/${skill}/`] };
  const problems = [];
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
  for (const tag of [`skill:${skill}`, 'real-usage', `snag:${n}`]) {
    if (!new RegExp(`^tags:.*\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(prompt)) problems.push(`prompt.md is missing the tag ${tag}`);
  }
  const files = [join(dir, 'prompt.md'), ...readdirSync(join(dir, 'graders')).map((f) => join(dir, 'graders', f))];
  for (const file of files) if (readFileSync(file, 'utf8').includes(TODO)) problems.push(`${file.slice(dir.length + 1)} still contains ${TODO}`);
  if (!readdirSync(join(dir, 'graders')).some((f) => f.endsWith('.md'))) problems.push('no grader in graders/');
  // claude plugin eval accepts only these spellings for a regex grader's match
  // (it rejects booleans); catching it here avoids a failed, paid eval run.
  for (const file of readdirSync(join(dir, 'graders')).filter((f) => f.endsWith('.md'))) {
    const m = /^match:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(readFileSync(join(dir, 'graders', file), 'utf8'));
    if (m && !/^(not_contains|count:\d+)$/.test(m[1])) problems.push(`graders/${file}: match must be not_contains or count:N (got ${m[1]})`);
  }
  return { ok: problems.length === 0, dir, problems };
}

function readInput(path) {
  let input;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new FixError(`cannot read ${path}: ${error.message}`);
  }
  if (!REPO_NAME.test(input.repo ?? '')) throw new FixError('fix.json: "repo" must be owner/repo');
  requireSkill(input.skill);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new FixError('fix.json: "title" is required');
  if (!Array.isArray(input.groups) || input.groups.length === 0) throw new FixError('fix.json: "groups" must list at least one fix');
  for (const g of input.groups) {
    if (!Array.isArray(g.issues) || g.issues.length === 0 || !g.issues.every((i) => Number.isInteger(i) && i > 0)) throw new FixError('fix.json: every group needs "issues" (issue numbers)');
    for (const key of ['summary', 'cause', 'change']) if (typeof g[key] !== 'string' || !g[key].trim()) throw new FixError(`fix.json: every group needs "${key}"`);
  }
  return input;
}

// Text in the PR comes partly from issues; it must not ping people.
function quiet(text) {
  return String(text).replace(/(^|[\s(])@([A-Za-z0-9][A-Za-z0-9-]*)/g, '$1`@$2`').trim();
}

function skillCommit(root, skill) {
  const r = run('git', ['-C', root, 'log', '-1', '--format=%H', '--', join('skills', skill)]);
  return r.ok && r.stdout ? r.stdout : undefined;
}

/** The newest eval record for the skill at its current commit, if any. */
export function evalForCommit(skill, commit, env = process.env) {
  if (!commit) return undefined;
  const dir = join(env.SNAGLOG_HOME || join(homedir(), '.snaglog'), 'evals', skill);
  if (!existsSync(dir)) return undefined;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (r.commit === commit && !r.dirty) return r;
    } catch {
      // skip unreadable records
    }
  }
  return undefined;
}

const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'n/a');

/** Build the exact PR title and body. */
export function prBody({ root, input, env = process.env }) {
  const issues = [...new Set(input.groups.flatMap((g) => g.issues))].sort((a, b) => a - b);
  const title = `fix(${input.skill}): ${quiet(input.title).replace(/\s+/g, ' ').slice(0, 72)}`;
  const lines = [`Fixes snags reported for the \`${input.skill}\` skill.`, '', '## Snags'];
  for (const g of input.groups) {
    lines.push('', `### ${quiet(g.summary)}`, '', `Reports: ${g.issues.map((i) => `#${i}`).join(', ')}`, '', `**Cause:** ${quiet(g.cause)}`, '', `**Change:** ${quiet(g.change)}`);
    if (Array.isArray(g.cases) && g.cases.length) lines.push('', `**Eval cases added:** ${g.cases.map((c) => `\`${String(c).replace(/`/g, '')}\``).join(', ')}`);
  }
  const commit = skillCommit(root, input.skill);
  const record = evalForCommit(input.skill, commit, env);
  lines.push('', '## Eval');
  if (record) {
    lines.push(
      '',
      `\`snaglog eval ${input.skill}\` at ${commit.slice(0, 7)} (Claude Code ${record.claudeVersion ?? 'unknown'}${record.partial ? ', partial run' : ''}):`,
      '',
      '| Cases | Score | Skill effect | Cost |',
      '|---|---|---|---|',
      `| ${(record.cases ?? []).length} | ${pct(record.score)} | ${record.ablation && typeof record.meanDelta === 'number' ? `${record.meanDelta >= 0 ? '+' : ''}${Math.round(record.meanDelta * 100)} pts` : 'not measured'} | ${typeof record.costUsd === 'number' ? `$${record.costUsd.toFixed(2)}` : 'n/a'} |`,
    );
    const failing = (record.cases ?? []).filter((c) => typeof c.score === 'number' && c.score < 1);
    if (failing.length) lines.push('', `Not fully passing: ${failing.map((c) => `\`${c.name}\` (${pct(c.score)})`).join(', ')}`);
  } else {
    lines.push('', `Not run for this commit. Run \`snaglog eval ${input.skill}\` before merging (it costs money; it asks first).`);
  }
  lines.push('', '---', '', ...issues.map((i) => `Fixes #${i}`), '', '<sub>Opened by the snaglog fix-snags skill after the skill owner approved this text. It is never merged automatically.</sub>');
  const body = lines.join('\n');
  return { title, body, issues, eval: record ? 'included' : 'not run' };
}

export function approvalToken(repo, branch, title, body) {
  return createHash('sha256').update(`${repo}\n${branch}\n${title}\n${body}`).digest('hex').slice(0, 12);
}

/** Push the branch and open the pull request; never merges. */
export function openPr({ root, input, branch, approve, env = process.env }) {
  if (!BRANCH.test(branch ?? '') || /\.\.|\/\/|^\/|\/$/.test(branch)) throw new FixError('--branch must be a plain branch name');
  const { title, body } = prBody({ root, input, env });
  if (approve !== approvalToken(input.repo, branch, title, body)) {
    throw new FixError('approval token does not match this pull request; run pr-body again and show the new text', 3);
  }
  const current = run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!current.ok || current.stdout !== branch) throw new FixError(`the checkout is on "${current.stdout}", not "${branch}"`, 3);
  const ghPath = env.SNAGLOG_GH || 'gh';
  if (run(ghPath, ['--version'], { env }).missing) throw new FixError('the GitHub CLI (gh) is not installed', 4);
  if (!run(ghPath, ['auth', 'status'], { env }).ok) throw new FixError('gh is not logged in; run `gh auth login` yourself', 4);
  const push = run(env.SNAGLOG_GIT || 'git', ['-C', root, 'push', '--set-upstream', 'origin', branch], { env });
  if (!push.ok) throw new FixError(`git push failed: ${push.stderr || 'unknown error'}`, 4);
  const pr = run(ghPath, ['pr', 'create', '--repo', input.repo, '--head', branch, '--title', title, '--body-file', '-'], { env, input: body, cwd: root });
  if (!pr.ok) throw new FixError(`gh pr create failed: ${pr.stderr || 'unknown error'}`, 4);
  return { status: 'opened', url: pr.stdout.split(/\s+/).pop(), branch };
}

export function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i].replace(/^--/, '');
    if (!['root', 'skill', 'issue', 'slug', 'input', 'branch', 'approve'].includes(key) || !rest[i].startsWith('--')) throw new FixError(`unknown option ${rest[i]}`);
    opts[key] = rest[(i += 1)];
  }
  const root = resolve(opts.root ?? process.cwd());
  switch (command) {
    case 'new-case':
      return newCase({ root, skill: opts.skill, issue: opts.issue, slug: opts.slug });
    case 'check-case':
      return checkCase({ root, skill: opts.skill, issue: opts.issue });
    case 'pr-body': {
      const input = readInput(opts.input);
      const result = prBody({ root, input, env });
      const branch = opts.branch ?? run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout;
      return { ...result, branch, approval: approvalToken(input.repo, branch, result.title, result.body) };
    }
    case 'open-pr':
      return openPr({ root, input: readInput(opts.input), branch: opts.branch, approve: opts.approve, env });
    default:
      throw new FixError('usage: fix-pr.mjs new-case|check-case|pr-body|open-pr [options] (see the header of this file)');
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`fix-pr: ${error.message}\n`);
    process.exit(error instanceof FixError ? error.exitCode : 1);
  }
}
