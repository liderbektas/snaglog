// `snaglog init --repo owner/repo` — wire every skill in a repository to
// snaglog. It builds a complete plan first, prints it, and changes nothing
// until the user confirms (or `--yes` is given). Running it twice is safe:
// the second run finds nothing to do.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { confirm } from './lib/confirm.mjs';
import { gh, ghCheck, REPO_NAME } from './lib/gh.mjs';
import { appendReminder, BUNDLED_SKILLS, findSkills, setMetadataKey, SKILL_NAME, skillsParent } from './lib/skills.mjs';
import { detectLayout } from './lib/layout.mjs';

const PACKAGE_SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));
const LABELS = {
  friction: { color: 'D93F0B', description: 'Snag report filed by an agent with the snaglog log-snag skill' },
  skill: { color: '0E8A16', description: 'Snags about one skill' },
};

const USAGE = `Usage: snaglog init --repo owner/repo [options]

Wire every skill in a local checkout to snaglog:
  1. add metadata.snaglog-repo to each SKILL.md
  2. append the snag reminder to each SKILL.md
  3. create the skill-friction and skill:<name> labels on GitHub
  4. copy the bundled snaglog skills (log-snag, fix-snags)
  5. create an eval skeleton for skills that have none
  6. keep eval results (which contain transcripts) out of git

Options:
  --repo owner/repo   GitHub repository that receives snag reports (required)
  --path <dir>        Local checkout of that repository (default: current directory)
  --skills-dir <dir>  Where bundled skills go, if the repo keeps skills in several folders
  --dry-run           Show the plan and exit without changing anything
  --yes               Apply without asking (review a --dry-run first)
  -h, --help          Show this help`;

function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === '.gitkeep' || entry.name === '.DS_Store') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function evalSkeleton(name) {
  return {
    'README.md': `# Evals for \`${name}\`

Cases for Claude Code's official \`claude plugin eval\` command. Each case is a
folder holding \`prompt.md\` and \`graders/*.md\`.

The example below is inactive (\`.example\` files are not loaded). To activate it,
rename \`example-case/prompt.md.example\` to \`prompt.md\` and
\`example-case/graders/uses-skill.md.example\` to \`uses-skill.md\`, then edit both.

Tag every case with \`skill:${name}\` and exactly one category:
\`golden\` (fixed input and expected output, ~5%), \`real-usage\` (real prompts and
snag reproductions, ~80%) or \`owner-reviewed\` (~15%).

Prefer free graders (\`regex\`, \`tool_used\`, \`tool_order\`, \`file_exists\`); use
\`llm\` graders only when a deterministic check is impossible.
`,
    'example-case/prompt.md.example': `---
name: ${name}-example
description: Replace with what this case checks.
tags: [skill:${name}, golden]
runs: 3
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

Replace with a task that should make the agent use the \`${name}\` skill.
`,
    'example-case/graders/uses-skill.md.example': `---
type: tool_used
tool: Skill
arm: both
---
`,
  };
}

function remoteRepo(root) {
  const r = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m?.[1];
}

/** Build the full plan without changing anything. */
export function buildPlan({ repo, root, skillsDir, env = process.env }) {
  const changes = [];
  const warnings = [];
  const all = findSkills(root);
  const skills = all.filter((s) => !BUNDLED_SKILLS.includes(s.name));
  const bundledAt = Object.fromEntries(all.filter((s) => BUNDLED_SKILLS.includes(s.name)).map((s) => [s.name, s.dir]));
  const valid = [];

  for (const skill of skills) {
    if (!skill.hasFrontmatter) {
      warnings.push(`${skill.rel}: no frontmatter, skipped`);
      continue;
    }
    if (SKILL_NAME.test(skill.name)) valid.push(skill);
    else warnings.push(`${skill.rel}: name "${skill.name}" is not a valid skill name; labels and evals skipped`);

    const original = readFileSync(skill.file, 'utf8');
    const meta = setMetadataKey(original, 'snaglog-repo', repo);
    if (meta.action === 'skipped') {
      warnings.push(`${skill.rel}: ${meta.reason}`);
      continue;
    }
    const reminder = appendReminder(meta.text);
    if (meta.action === 'added') changes.push({ where: skill.rel, what: `add metadata.snaglog-repo: ${repo}` });
    if (meta.action === 'updated') changes.push({ where: skill.rel, what: `change metadata.snaglog-repo: ${meta.previous} → ${repo}` });
    if (reminder.action === 'added') changes.push({ where: skill.rel, what: 'append the snag reminder line' });
    if (reminder.text !== original) {
      changes.push({ hidden: true, apply: () => writeFileSync(skill.file, reminder.text) });
    }
  }

  const layout = detectLayout(root);
  if (!skills.length) warnings.push(`no skills found; log-snag and fix-snags will be added to ${relative(root, layout.skillsDir)}/, where Claude Code loads them`);
  const parent = skillsDir ? resolve(root, skillsDir) : skills.length ? skillsParent(root, skills) : layout.skillsDir;
  if (!parent) {
    warnings.push('skills live in several folders; pass --skills-dir to choose where the bundled skills go');
  } else {
    for (const name of BUNDLED_SKILLS) {
      const source = join(PACKAGE_SKILLS, name);
      if (!existsSync(join(source, 'SKILL.md'))) continue;
      const target = bundledAt[name] ?? join(parent, name);
      const pending = [];
      for (const file of filesUnder(source)) {
        const dest = join(target, relative(source, file));
        const content = readFileSync(file);
        if (existsSync(dest) && readFileSync(dest).equals(content)) continue;
        pending.push({ dest, content, mode: statSync(file).mode & 0o777 });
      }
      if (!pending.length) continue;
      const verb = existsSync(target) ? `update bundled skill ${name} (${pending.length} file${pending.length > 1 ? 's' : ''})` : `copy bundled skill ${name}`;
      changes.push({
        where: `${relative(root, target)}/`,
        what: verb,
        apply: () => {
          for (const { dest, content, mode } of pending) {
            mkdirSync(join(dest, '..'), { recursive: true });
            writeFileSync(dest, content, { mode });
          }
        },
      });
    }
  }

  for (const skill of valid) {
    const dir = join(layout.evalsDir, skill.name);
    if (existsSync(dir)) continue;
    changes.push({
      where: `${layout.evalsRel}/${skill.name}/`,
      what: 'create an inactive eval skeleton',
      apply: () => {
        for (const [file, content] of Object.entries(evalSkeleton(skill.name))) {
          const path = join(dir, file);
          mkdirSync(join(path, '..'), { recursive: true });
          writeFileSync(path, content);
        }
      },
    });
  }

  const gitignore = join(root, '.gitignore');
  const ignoreText = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const resultsIgnore = `${layout.evalsRel}/results/`;
  const ignored = ignoreText.split(/\r?\n/).some((line) => [resultsIgnore, resultsIgnore.slice(0, -1), `/${resultsIgnore}`, `/${resultsIgnore.slice(0, -1)}`].includes(line.trim()));
  if (!ignored) {
    changes.push({
      where: '.gitignore',
      what: `ignore ${resultsIgnore} (eval results contain transcripts)`,
      apply: () => writeFileSync(gitignore, `${ignoreText}${ignoreText && !ignoreText.endsWith('\n') ? '\n' : ''}${resultsIgnore}\n`),
    });
  }

  const wanted = [
    { name: 'skill-friction', ...LABELS.friction },
    ...valid.map((s) => ({ name: `skill:${s.name}`, color: LABELS.skill.color, description: `${LABELS.skill.description}: ${s.name}` })),
  ];
  const check = ghCheck(repo, env);
  if (!check.ok) {
    warnings.push(`labels not checked: ${check.reason}; run init again once gh works`);
  } else {
    const list = gh(['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000'], { env });
    let existing = [];
    try {
      existing = list.ok ? JSON.parse(list.stdout).map((l) => l.name) : [];
    } catch {
      existing = [];
    }
    if (!list.ok) warnings.push(`labels not checked: could not list labels on ${repo}`);
    else {
      for (const label of wanted.filter((l) => !existing.includes(l.name))) {
        changes.push({
          where: `GitHub ${repo}`,
          what: `create label ${label.name}`,
          remote: true,
          apply: () => gh(['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description], { env }),
        });
      }
    }
  }

  const origin = remoteRepo(root);
  if (origin && origin.toLowerCase() !== repo.toLowerCase()) {
    warnings.push(`this checkout's origin is ${origin}, not ${repo}`);
  }

  return { skills, changes, warnings };
}

export async function run(args, io, deps = {}) {
  const env = deps.env ?? process.env;
  const ask = deps.confirm ?? ((q) => confirm(q));
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        path: { type: 'string' },
        'skills-dir': { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    io.err(`snaglog init: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (!values.repo || !REPO_NAME.test(values.repo)) {
    io.err(`snaglog init: --repo owner/repo is required\n\n${USAGE}`);
    return 2;
  }
  const root = resolve(values.path ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    io.err(`snaglog init: ${root} is not a directory`);
    return 2;
  }

  const plan = buildPlan({ repo: values.repo, root, skillsDir: values['skills-dir'], env });
  const visible = plan.changes.filter((c) => !c.hidden);
  io.out(`snaglog init — ${values.repo} (${root})`);
  io.out(`Skills found: ${plan.skills.length ? plan.skills.map((s) => s.name).join(', ') : 'none'}`);
  for (const warning of plan.warnings) io.out(`warning: ${warning}`);

  if (!visible.length) {
    io.out('Nothing to do: everything is already set up.');
    return 0;
  }
  io.out(`\nPlanned changes (${visible.length}):`);
  const width = Math.max(...visible.map((c) => c.where.length));
  for (const change of visible) io.out(`  ${change.where.padEnd(width)}  ${change.what}`);
  const remote = visible.filter((c) => c.remote).length;
  if (remote) io.out(`\n${remote} of these write to GitHub (labels only).`);

  if (values['dry-run']) {
    io.out('\nDry run: nothing was changed.');
    return 0;
  }
  if (!values.yes) {
    const answer = await ask(`\nApply these ${visible.length} changes?`);
    if (answer === null) {
      io.err('snaglog init: no terminal to confirm; review `--dry-run`, then re-run with --yes');
      return 1;
    }
    if (!answer) {
      io.out('Cancelled: nothing was changed.');
      return 1;
    }
  }

  const failures = [];
  for (const change of plan.changes.filter((c) => !c.remote && c.apply)) change.apply();
  for (const change of plan.changes.filter((c) => c.remote)) {
    const r = change.apply();
    if (!r.ok) failures.push(`${change.what}: ${r.stderr.trim() || 'gh failed'}`);
  }
  for (const failure of failures) io.err(`failed: ${failure}`);
  io.out(`\nApplied ${visible.length - failures.length} of ${visible.length} changes. Review with \`git diff\` and commit when ready.`);
  return failures.length ? 1 : 0;
}
