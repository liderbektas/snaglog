// `snaglog eval [<skill>] [--all] [--ablate]` — run Claude Code's official
// `claude plugin eval` for skills in a repo and record each result with the
// skill's git commit.
//
// Running evals costs money (model calls on the user's Claude account), so
// this command always prints the plan, an estimate and a hard per-run ceiling
// first and runs nothing until the user confirms. By default only skills that
// changed since their last recorded eval are selected.
//
// Every run passes --no-publish (the default would publish the report, which
// contains prompts, to claude.ai) and never passes flags that run extra code
// or skip trust checks. Full results are written to a temporary directory
// and deleted after the allow-listed summary is stored.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { caseSkills, summarizeResult } from './collect/evals.mjs';
import { confirm } from './lib/confirm.mjs';
import { CATEGORIES, estimateCost, fingerprint, lastRecord, listCases } from './lib/eval-cases.mjs';
import { readJson, snaglogHome, writeJson } from './lib/home.mjs';
import { BUNDLED_SKILLS, findSkills } from './lib/skills.mjs';

export const MIN_CLAUDE = [2, 1, 269];
export const MIN_GIT = [2, 31, 0];
export const DEFAULT_MAX_COST_USD = 1;
// Flags snaglog must never pass to `claude plugin eval`.
export const FORBIDDEN_FLAGS = ['--publish-report', '--scaffold', '--allow-real-servers', '--trust-plugin', '--mocks', '--allow-tools'];

const USAGE = `Usage: snaglog eval [<skill>] [options]

Runs Claude Code's official \`claude plugin eval\` for skills in a skills repo
and records each result with the skill's git commit. Evals use your Claude
account and cost money: the plan, an estimate and a hard ceiling per run are
always shown first, and nothing runs until you confirm.

Without <skill>, only skills that changed since their last recorded eval run.

Options:
  --all                 Select every skill that has eval cases
  --ablate              Also run a baseline without the skills (doubles the cost)
  --path <dir>          Skills repo checkout (default: current directory)
  --max-cost-usd <usd>  Hard ceiling per skill run (default: ${DEFAULT_MAX_COST_USD})
  --runs <n>            Override runs per case (fewer runs cost less)
  --keep-report         Keep Claude Code's full report in evals/results/ (git-ignored;
                        contains prompts and transcripts)
  --dry-run             Show the plan and estimate, run nothing
  --yes                 Do not ask for confirmation
  -h, --help            Show this help`;

const money = (usd) => `$${usd.toFixed(2)}`;

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? m.slice(1).map(Number) : undefined;
}

function atLeast(version, min) {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

function claudeBin(env) {
  return env.SNAGLOG_CLAUDE || 'claude';
}

/** Free checks only: `claude --version` and `git --version`. */
export function checkTools(env) {
  const claude = spawnSync(claudeBin(env), ['--version'], { encoding: 'utf8', env });
  if (claude.error) return 'Claude Code (`claude`) is not installed';
  const version = parseVersion(claude.stdout);
  if (!version || !atLeast(version, MIN_CLAUDE)) return `claude plugin eval needs Claude Code ${MIN_CLAUDE.join('.')} or later (found ${version ? version.join('.') : 'unknown'})`;
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const gitVersion = git.error ? undefined : parseVersion(git.stdout);
  if (gitVersion && !atLeast(gitVersion, MIN_GIT)) return `claude plugin eval needs git ${MIN_GIT.slice(0, 2).join('.')} or later`;
  return undefined;
}

/** The exact argument list for one run. Exported so tests can pin it. */
export function evalArgs({ root, skill, ablate, maxCostUsd, runs, jsonPath, outputDir }) {
  const args = [
    'plugin', 'eval', root,
    '--tag', `skill:${skill}`,
    '--ablation', ablate ? 'with-without' : 'none',
    '--no-publish',
    '--json', jsonPath,
    '--output-dir', outputDir,
    '--max-cost-usd', String(maxCostUsd),
  ];
  if (runs) args.push('--runs', String(runs));
  for (const flag of FORBIDDEN_FLAGS) if (args.includes(flag)) throw new Error(`refusing to pass ${flag}`);
  return args;
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function plan({ root, home, wanted, all, ablate, maxCostUsd }) {
  const skills = findSkills(join(root, 'skills')).filter((s) => !BUNDLED_SKILLS.includes(s.name));
  const cases = listCases(root);
  const warnings = [];
  const known = new Set(skills.map((s) => s.name));
  let selected;
  if (wanted) {
    if (!known.has(wanted)) return { error: `no skill "${wanted}" under ${join(root, 'skills')}` };
    selected = [wanted];
  } else {
    selected = skills.map((s) => s.name).filter((name) => {
      if (!cases.has(name)) return false;
      return all || lastRecord(home, name)?.fingerprint !== fingerprint(root, name);
    });
  }
  const rows = [];
  for (const skill of selected) {
    const skillCases = cases.get(skill) ?? [];
    if (!skillCases.length) {
      warnings.push(`${skill}: no active eval cases in evals/${skill}/ (rename the .example files to start)`);
      continue;
    }
    const untagged = skillCases.filter((c) => !c.tags.includes(`skill:${skill}`));
    if (untagged.length) warnings.push(`${skill}: ${untagged.map((c) => c.name).join(', ')} lack the tag skill:${skill} and will not run`);
    const runnable = skillCases.length - untagged.length;
    if (!runnable) continue;
    const mix = Object.fromEntries(CATEGORIES.map((c) => [c, skillCases.filter((k) => k.category === c).length]));
    rows.push({ skill, cases: runnable, mix, estimate: estimateCost(lastRecord(home, skill), runnable, ablate), ceiling: maxCostUsd });
  }
  return { rows, warnings };
}

function printPlan(io, rows, { ablate, maxCostUsd }) {
  io.out(`\nPlanned eval runs (${rows.length})${ablate ? ', with a no-skills baseline' : ''}:`);
  for (const row of rows) {
    const est = row.estimate.usd === null ? 'unknown' : `~${money(row.estimate.usd)}`;
    const mix = CATEGORIES.map((c) => `${row.mix[c]} ${c}`).join(', ');
    io.out(`  ${row.skill}: ${row.cases} case${row.cases === 1 ? '' : 's'} (${mix}); estimate ${est}; stops at ${money(row.ceiling)}`);
  }
  const knownSum = rows.reduce((sum, r) => sum + (r.estimate.usd ?? 0), 0);
  const unknown = rows.filter((r) => r.estimate.usd === null).length;
  io.out(`\nEstimated cost: ${money(knownSum)}${unknown ? ` plus ${unknown} run${unknown === 1 ? '' : 's'} without history` : ''}. Hard ceiling: ${money(maxCostUsd * rows.length)} (${money(maxCostUsd)} per run).`);
  io.out('Evals run on your Claude account: they use your subscription usage or are billed as API usage.');
}

function record({ root, home, skill, result, ablate, exitCode, keepReport, outputDir }) {
  const ranAt = new Date().toISOString();
  const summary = summarizeResult(result, { cases: caseSkills(root), ranAt }).find((s) => s.skill === skill);
  if (!summary) return undefined;
  const skillDir = join(root, 'skills', skill);
  const entry = {
    ...summary,
    // Only this skill's cases ran, so the whole run's cost belongs to it.
    costUsd: typeof result?.costUsd === 'number' ? result.costUsd : null,
    source: 'snaglog eval',
    ablation: Boolean(ablate),
    commit: git(root, ['log', '-1', '--format=%H', '--', skillDir]) ?? null,
    dirty: Boolean(git(root, ['status', '--porcelain', '--', skillDir, join(root, 'evals', skill)])),
    fingerprint: fingerprint(root, skill),
    exitCode,
    allPassed: summary.cases.length > 0 && summary.cases.every((c) => c.score === 1),
  };
  const file = join(home, 'evals', skill, `${ranAt.replace(/[:.]/g, '-')}.json`);
  writeJson(file, entry);
  if (keepReport) {
    // Tell `snaglog collect` this report is already recorded.
    const index = join(home, 'evals', 'imported.json');
    const report = join(outputDir, 'aggregate-result.json');
    if (existsSync(report)) {
      writeJson(index, [...new Set([...readJson(index, []), `${report}:${statSync(report).mtimeMs}`])]);
    }
  }
  return { entry, file };
}


export async function run(args, io, deps = {}) {
  const env = deps.env ?? process.env;
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        all: { type: 'boolean' },
        ablate: { type: 'boolean' },
        path: { type: 'string' },
        'max-cost-usd': { type: 'string' },
        runs: { type: 'string' },
        'keep-report': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    io.err(`snaglog eval: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const maxCostUsd = values['max-cost-usd'] === undefined ? DEFAULT_MAX_COST_USD : Number(values['max-cost-usd']);
  const runs = values.runs === undefined ? undefined : Number(values.runs);
  if (!(maxCostUsd > 0) || (runs !== undefined && !(Number.isInteger(runs) && runs >= 1 && runs <= 50))) {
    io.err('snaglog eval: --max-cost-usd must be a positive number and --runs an integer from 1 to 50');
    return 2;
  }
  if (positionals.length > 1 || (positionals.length && values.all)) {
    io.err('snaglog eval: give one skill or --all, not both');
    return 2;
  }

  const root = resolve(values.path ?? process.cwd());
  if (!existsSync(join(root, 'skills'))) {
    io.err(`snaglog eval: ${root} has no skills/ directory; claude plugin eval loads skills from <repo>/skills/<name>/SKILL.md`);
    return 2;
  }
  const home = snaglogHome(env);
  const ablate = Boolean(values.ablate);
  const { rows, warnings, error } = plan({ root, home, wanted: positionals[0], all: values.all, ablate, maxCostUsd });
  if (error) {
    io.err(`snaglog eval: ${error}`);
    return 2;
  }
  io.out(`snaglog eval — ${root}`);
  for (const warning of warnings) io.out(`warning: ${warning}`);
  if (!rows.length) {
    io.out(positionals[0] || values.all ? 'Nothing to run.' : 'Nothing to run: no skill changed since its last recorded eval (name a skill or use --all).');
    return 0;
  }
  printPlan(io, rows, { ablate, maxCostUsd });
  if (values['dry-run']) {
    io.out('\nDry run: nothing was run.');
    return 0;
  }

  const problem = checkTools(env);
  if (problem) {
    io.err(`snaglog eval: ${problem}`);
    return 1;
  }
  if (!values.yes) {
    const answer = await (deps.confirm ?? ((q) => confirm(q)))(`\nRun ${rows.length} eval${rows.length === 1 ? '' : 's'}? This costs money.`);
    if (answer === null) {
      io.err('snaglog eval: no terminal to confirm; review --dry-run, then re-run with --yes');
      return 1;
    }
    if (!answer) {
      io.out('Cancelled: nothing was run.');
      return 1;
    }
  }

  let failed = 0;
  for (const row of rows) {
    const tmp = mkdtempSync(join(tmpdir(), 'snaglog-eval-'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = values['keep-report'] ? join(root, 'evals', 'results', stamp) : join(tmp, 'out');
    mkdirSync(outputDir, { recursive: true });
    const jsonPath = join(tmp, 'result.json');
    io.out(`\n▶ ${row.skill}`);
    try {
      const r = spawnSync(claudeBin(env), evalArgs({ root, skill: row.skill, ablate, maxCostUsd, runs, jsonPath, outputDir }), { stdio: 'inherit', env });
      const exitCode = r.status ?? (r.signal ? 130 : 1);
      if (exitCode === 130 || exitCode === 143) {
        io.err(`${row.skill}: interrupted; stopping`);
        failed += 1;
        break;
      }
      let result;
      try {
        result = JSON.parse(readFileSync(jsonPath, 'utf8'));
      } catch {
        result = undefined;
      }
      if (!result) {
        failed += 1;
        io.err(`${row.skill}: claude plugin eval produced no result (exit ${exitCode}). If it reported "currently unavailable", Anthropic has switched the command off for now.`);
        continue;
      }
      const saved = record({ root, home, skill: row.skill, result, ablate, exitCode, keepReport: values['keep-report'], outputDir });
      if (!saved) {
        failed += 1;
        io.err(`${row.skill}: the result contains none of this skill's cases`);
        continue;
      }
      const { entry } = saved;
      const parts = [`score ${entry.score === null ? 'n/a' : `${Math.round(entry.score * 100)}%`}`];
      if (ablate && entry.meanDelta !== null) parts.push(`difference vs. no skills ${entry.meanDelta >= 0 ? '+' : ''}${Math.round(entry.meanDelta * 100)} pts`);
      if (entry.costUsd !== null) parts.push(`cost ${money(entry.costUsd)}`);
      if (entry.partial) parts.push('PARTIAL (cost ceiling or credential)');
      if (entry.commit) parts.push(`commit ${entry.commit.slice(0, 7)}${entry.dirty ? ' + uncommitted changes' : ''}`);
      io.out(`${row.skill}: ${parts.join(', ')}`);
      if (entry.allPassed) io.out(`${row.skill}: every case passed — the cases may be too easy to catch regressions.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}
