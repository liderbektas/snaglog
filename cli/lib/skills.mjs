// Find skills in a repository and edit their SKILL.md files without
// disturbing anything snaglog does not own: only one key inside `metadata`
// and one reminder line at the end of the body are ever touched.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseFrontmatter } from '../../skills/log-snag/scripts/file-snag.mjs';

export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const BUNDLED_SKILLS = ['log-snag', 'fix-snags'];
export const SNAG_REMINDER =
  "If this skill doesn't work as described, file a snag with the log-snag skill before working around it.";

const SKIP_DIRS = new Set(['.git', 'node_modules', 'evals', '.snaglog', '.caliper']);
const MAX_DEPTH = 8;

/** Every SKILL.md under root (symlinks are not followed). */
export function findSkills(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path, depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const text = readFileSync(path, 'utf8');
        const fm = parseFrontmatter(text);
        found.push({
          name: typeof fm.name === 'string' && fm.name ? fm.name : basename(dir),
          dir,
          file: path,
          rel: relative(root, path),
          hasFrontmatter: /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text),
        });
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

const FRONTMATTER = /^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/;

function unquote(value) {
  const v = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(v);
  return quoted ? quoted[2] : v.replace(/\s+#.*$/, '');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Set `metadata.<key>: <value>` in a SKILL.md, keeping every other byte.
 * Returns { action: 'added' | 'updated' | 'unchanged' | 'skipped', text, previous?, reason? }.
 */
export function setMetadataKey(text, key, value) {
  const match = FRONTMATTER.exec(text);
  if (!match) return { action: 'skipped', reason: 'SKILL.md has no frontmatter', text };
  const eol = match[1];
  const lines = match[2].split(/\r?\n/);
  const rest = text.slice(match[0].length);
  const rebuild = () => `---${eol}${lines.join(eol)}${eol}---${match[3] || eol}${rest}`;

  const metaIndex = lines.findIndex((line) => /^metadata:/.test(line));
  if (metaIndex === -1) {
    lines.push('metadata:', `  ${key}: ${value}`);
    return { action: 'added', text: rebuild() };
  }

  const inline = lines[metaIndex].replace(/^metadata:/, '').replace(/\s+#.*$/, '').trim();
  if (inline === '{}') lines[metaIndex] = 'metadata:';
  else if (inline !== '') return { action: 'skipped', reason: 'metadata is written inline; add the key by hand', text };

  let last = metaIndex;
  let indent;
  for (let i = metaIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^[ \t]/.test(line)) break;
    last = i;
    indent ??= /^[ \t]+/.exec(line)[0];
  }
  indent ??= '  ';

  const keyLine = new RegExp(`^${escapeRegExp(indent)}${escapeRegExp(key)}:(?:\\s+(.*))?$`);
  for (let i = metaIndex + 1; i <= last; i += 1) {
    const found = keyLine.exec(lines[i]);
    if (!found) continue;
    const previous = unquote(found[1] ?? '');
    if (previous === value) return { action: 'unchanged', text };
    lines[i] = `${indent}${key}: ${value}`;
    return { action: 'updated', previous, text: rebuild() };
  }
  lines.splice(last + 1, 0, `${indent}${key}: ${value}`);
  return { action: 'added', text: rebuild() };
}

/** Append the snag reminder to the end of the body unless it is already there. */
export function appendReminder(text, reminder = SNAG_REMINDER) {
  const match = FRONTMATTER.exec(text);
  const body = match ? text.slice(match[0].length) : text;
  if (body.includes(reminder)) return { action: 'unchanged', text };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { action: 'added', text: `${text.replace(/\s+$/, '')}${eol}${eol}${reminder}${eol}` };
}

/** The directory bundled skills go into: the common parent of the repo's skills. */
export function skillsParent(root, skills) {
  const parents = [...new Set(skills.map((s) => dirname(s.dir)))];
  if (parents.length === 1) return parents[0];
  if (parents.length === 0) return join(root, 'skills');
  return undefined;
}
