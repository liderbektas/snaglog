// Where a repository keeps its skills and eval cases.
//
//   skills repo  <root>/skills/<name>/SKILL.md          evals in <root>/evals/
//   project      <root>/.claude/skills/<name>/SKILL.md  evals in <root>/.claude/evals/
//
// A root-level skills/ folder marks a dedicated skills repo; anything else is
// treated as a project, where Claude Code loads skills from .claude/skills.
// Either folder loads as a plugin from its parent (verified offline with
// `claude --plugin-dir <dir> plugin details`), which is what
// `claude plugin eval` targets.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function detectLayout(root) {
  if (existsSync(join(root, 'skills'))) {
    return { kind: 'skills-repo', pluginRoot: root, skillsDir: join(root, 'skills'), evalsDir: join(root, 'evals'), evalsRel: 'evals' };
  }
  const pluginRoot = join(root, '.claude');
  return { kind: 'project', pluginRoot, skillsDir: join(pluginRoot, 'skills'), evalsDir: join(pluginRoot, 'evals'), evalsRel: '.claude/evals' };
}
