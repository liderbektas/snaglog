#!/usr/bin/env node
// file-snag.mjs — sanitize, preview and file a skill snag report.
//
// Part of the snaglog `log-snag` skill. No npm dependencies: this file is
// copied into other repositories and must run on a plain Node.js 20+.
//
//   node file-snag.mjs prepare    <report.json>
//   node file-snag.mjs submit     <report.json> --approve <token>
//   node file-snag.mjs save-local <report.json> --reason <rejected|unattended|...>
//
// `prepare` never writes anything to GitHub: it sanitizes the report, runs
// read-only `gh` checks and prints the exact title and body plus an approval
// token. `submit` re-sanitizes, refuses unless the token matches the same
// title, body and target repo, and only then files or comments on an issue.
// Every failure falls back to the local file ~/.snaglog/snags.jsonl.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = { title: 100, field: 2000, actualLines: 20 };
export const FRICTION_LABEL = 'skill-friction';
export const TRIGGERS = {
  'rejected-flag': 'A documented flag or option was rejected',
  'false-success': 'A command reported success but did not do its job',
  'empty-result': 'A query returned nothing where results were expected',
  'instruction-mismatch': 'The instructions did not match actual behaviour',
  'repeated-retries': 'The same step needed three or more attempts',
  other: 'Other',
};

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class SnagError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Sanitization
//
// Token shapes follow the vendors' own published formats (GitHub token
// prefixes, AWS access key ID prefixes, OpenAI / Anthropic / Slack / Google /
// Stripe / GitLab / npm key prefixes). Order matters: specific patterns run
// before generic ones so the redaction log names the right type.

const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['aws-access-key-id', /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['auth-header', /\b(Authorization|Proxy-Authorization|X-Api-Key|Private-Token|Cookie)(\s*[:=]\s*)(?:(Bearer|Basic|token)\s+)?[^\s"',;]+/gi],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi],
  ['secret-assignment', /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;]{4,})/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['home-path', /(?:\/Users|\/home)\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+/g],
  ['ip-address', /\b(?!127\.0\.0\.1\b)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
];

function replacement(type, match, groups) {
  switch (type) {
    case 'auth-header':
      return `${groups[0]}${groups[1]}${groups[2] ? `${groups[2]} ` : ''}[REDACTED]`;
    case 'url-credentials':
      return `${groups[0]}[REDACTED]@`;
    case 'secret-assignment':
      return `${groups[0]}${groups[1]}[REDACTED]`;
    case 'email':
      return '[REDACTED-EMAIL]';
    case 'home-path':
      return '~';
    case 'ip-address':
      return '[REDACTED-IP]';
    default:
      return `[REDACTED-${type.toUpperCase()}]`;
  }
}

/** Mask secrets and personal data. Returns the clean text and per-type counts. */
export function sanitize(text, counts = {}) {
  let out = String(text ?? '');
  for (const [type, re] of PATTERNS) {
    out = out.replace(re, (match, ...rest) => {
      const groups = rest.slice(0, -2);
      const replaced = replacement(type, match, groups);
      if (replaced === match) return match;
      counts[type] = (counts[type] ?? 0) + 1;
      return replaced;
    });
  }
  return { text: out, counts };
}

// Agent-written text must not ping people or break out of its code block.
function neutralizeMentions(text) {
  return text.replace(/(^|[\s(])@([A-Za-z0-9][A-Za-z0-9-]*)/g, '$1`@$2`');
}

function fenceFor(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(longest + 1);
}

// ---------------------------------------------------------------------------
// Skill metadata

function unquote(value) {
  const v = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(v);
  if (quoted) return quoted[2];
  return v.replace(/\s+#.*$/, '');
}

/** Minimal frontmatter reader: top-level scalars and one-level maps such as `metadata`. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const out = {};
  if (!match) return out;
  let currentMap = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (top) {
      const [, key, raw = ''] = top;
      if (raw.trim() === '') {
        out[key] = {};
        currentMap = key;
      } else {
        out[key] = unquote(raw);
        currentMap = null;
      }
      continue;
    }
    const nested = /^\s+([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (nested && currentMap) out[currentMap][nested[1]] = unquote(nested[2] ?? '');
  }
  return out;
}

function gitCommitOf(skillDir) {
  const r = spawnSync('git', ['-C', skillDir, 'log', '-1', '--format=%h', '--', 'SKILL.md'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Read name, version, commit and target repo for the skill the report is about. */
export function skillInfo(report, env = process.env) {
  const info = { name: report.skill, version: report.skillVersion, commit: undefined, repo: undefined, repoSource: undefined };
  if (report.skillDir) {
    const file = join(report.skillDir, 'SKILL.md');
    if (existsSync(file)) {
      const fm = parseFrontmatter(readFileSync(file, 'utf8'));
      if (fm.name && fm.name !== report.skill) {
        throw new SnagError(`skill "${report.skill}" does not match SKILL.md name "${fm.name}"`, 2);
      }
      const meta = typeof fm.metadata === 'object' ? fm.metadata : {};
      info.version ??= meta.version ?? (typeof fm.version === 'string' ? fm.version : undefined);
      if (meta['snaglog-repo']) {
        info.repo = meta['snaglog-repo'];
        info.repoSource = 'metadata.snaglog-repo';
      }
      info.commit = gitCommitOf(report.skillDir);
    }
  }
  if (!info.repo && env.SNAGLOG_REPO) {
    info.repo = env.SNAGLOG_REPO;
    info.repoSource = 'SNAGLOG_REPO';
  }
  if (info.repo && !REPO_NAME.test(info.repo)) {
    throw new SnagError(`target repo "${info.repo}" is not in owner/repo form`, 2);
  }
  return info;
}

// ---------------------------------------------------------------------------
// Report → issue

// Fields are returned whole: masking must run before any truncation, so a
// secret that straddles a cut can never leak as an unmasked fragment.
function requireText(report, key) {
  const value = report[key];
  if (typeof value !== 'string' || !value.trim()) throw new SnagError(`report field "${key}" is required`, 2);
  return value.trim();
}

function optionalText(report, key) {
  const value = report[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function clip(text, max = LIMITS.field) {
  return text.length > max ? `${text.slice(0, max)} …` : text;
}

export function validateReport(report) {
  if (!report || typeof report !== 'object') throw new SnagError('report must be a JSON object', 2);
  if (typeof report.skill !== 'string' || !SKILL_NAME.test(report.skill)) {
    throw new SnagError('report field "skill" must be a skill name (lowercase letters, digits, hyphens)', 2);
  }
  if (report.trigger !== undefined && !(report.trigger in TRIGGERS)) {
    throw new SnagError(`report field "trigger" must be one of: ${Object.keys(TRIGGERS).join(', ')}`, 2);
  }
  for (const key of ['summary', 'attempted', 'expected', 'actual']) requireText(report, key);
}

/** Build the sanitized issue title and body. Masks before truncating. */
export function buildIssue(report, info) {
  validateReport(report);
  const counts = {};
  const clean = (value) => clip(neutralizeMentions(sanitize(value, counts).text));

  const summary = clean(requireText(report, 'summary')).replace(/\s+/g, ' ').slice(0, LIMITS.title);
  const actualAll = sanitize(requireText(report, 'actual'), counts).text.split(/\r?\n/);
  const actual = actualAll.slice(0, LIMITS.actualLines).map((line) => clip(line, 300));
  if (actualAll.length > LIMITS.actualLines) actual.push(`… (${actualAll.length - LIMITS.actualLines} more lines omitted)`);
  const actualText = actual.join('\n');
  const fence = fenceFor(actualText);

  const versionBits = [info.version && `version ${clean(info.version)}`, info.commit && `commit ${info.commit}`].filter(Boolean);
  const agentBits = [report.agent && `**Agent:** ${clean(report.agent)}`, report.model && `**Model:** ${clean(report.model)}`].filter(Boolean);

  const sections = [
    `**Skill:** \`${report.skill}\`${versionBits.length ? ` (${versionBits.join(', ')})` : ''}`,
    agentBits.join(' · '),
    report.trigger ? `**Trigger:** ${TRIGGERS[report.trigger]}` : '',
    '',
    '### What was attempted',
    clean(requireText(report, 'attempted')),
    '',
    '### Expected',
    clean(requireText(report, 'expected')),
    '',
    '### What happened',
    `${fence}text`,
    actualText,
    fence,
  ];
  const workaround = optionalText(report, 'workaround');
  if (workaround) sections.push('', '### Workaround', clean(workaround));
  const fix = optionalText(report, 'suggestedFix');
  if (fix) sections.push('', '### Suggested fix', clean(fix));
  sections.push(
    '',
    '---',
    '<sub>Filed with the snaglog `log-snag` skill after the user reviewed and approved this exact text. Secrets and personal data were masked automatically; no prompt text or file contents are included.</sub>',
  );

  const body = sections.filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n').replace(/^\n+/, '');
  return { title: `[snag] ${report.skill}: ${summary}`, body, redactions: counts };
}

export function approvalToken(repo, title, body) {
  return createHash('sha256').update(`${repo ?? 'local'}\n${title}\n${body}`).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// gh

function ghPath(env) {
  return env.SNAGLOG_GH || 'gh';
}

function runGh(env, args, input) {
  const r = spawnSync(ghPath(env), args, {
    input,
    encoding: 'utf8',
    env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Read-only checks. Returns { ok, visibility } or { ok: false, reason }. */
export function preflight(repo, env = process.env) {
  if (runGh(env, ['--version']).missing) return { ok: false, reason: 'gh-missing' };
  if (!runGh(env, ['auth', 'status']).ok) return { ok: false, reason: 'gh-not-authenticated' };
  const view = runGh(env, ['repo', 'view', repo, '--json', 'nameWithOwner,visibility,hasIssuesEnabled']);
  if (!view.ok) return { ok: false, reason: 'no-access' };
  let data = {};
  try {
    data = JSON.parse(view.stdout);
  } catch {
    return { ok: false, reason: 'no-access' };
  }
  if (data.hasIssuesEnabled === false) return { ok: false, reason: 'issues-disabled' };
  return { ok: true, visibility: String(data.visibility ?? 'unknown').toLowerCase() };
}

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'be', 'been', 'not', 'no', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'for', 'from', 'and', 'or', 'with', 'when', 'but', 'does', 'do', 'it', 'this', 'that']);

function words(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** Dice similarity (0..1) of the meaningful words in two titles. */
export function titleSimilarity(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return (2 * shared) / (wa.size + wb.size);
}

export const SIMILARITY_THRESHOLD = 0.5;

function findDuplicate(repo, skill, title, env) {
  const r = runGh(env, ['issue', 'list', '--repo', repo, '--state', 'open', '--search', `"[snag] ${skill}:" in:title`, '--json', 'number,title,url', '--limit', '50']);
  if (!r.ok) return undefined;
  let issues = [];
  try {
    issues = JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
  const prefix = `[snag] ${skill}:`;
  const summary = title.slice(prefix.length);
  let best;
  for (const issue of issues) {
    if (typeof issue.title !== 'string' || !issue.title.startsWith(prefix)) continue;
    const score = titleSimilarity(summary, issue.title.slice(prefix.length));
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { ...issue, score };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Local file

export function snaglogHome(env = process.env) {
  return env.SNAGLOG_HOME || join(homedir(), '.snaglog');
}

function readState(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(home, state) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function appendLocal(env, record) {
  const home = snaglogHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'snags.jsonl');
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return file;
}

const REASON_TEXT = {
  rejected: 'The user declined to file the report.',
  unattended: 'No user was available to approve the report.',
  'no-target': 'The skill names no source repo (metadata.snaglog-repo) and SNAGLOG_REPO is not set.',
  'gh-missing': 'The GitHub CLI (gh) is not installed.',
  'gh-not-authenticated': 'The GitHub CLI is not logged in.',
  'no-access': 'The target repo does not exist or this account cannot access it.',
  'issues-disabled': 'Issues are disabled on the target repo.',
  'gh-error': 'gh failed while filing the issue.',
};

function saveLocalRecord(report, info, issue, reason, env) {
  const record = {
    id: randomUUID(),
    savedAt: new Date().toISOString(),
    status: 'unsent',
    reason,
    skill: report.skill,
    repo: info.repo ?? null,
    agent: typeof report.agent === 'string' ? sanitize(report.agent).text : undefined,
    model: typeof report.model === 'string' ? sanitize(report.model).text : undefined,
    title: issue.title,
    body: issue.body,
  };
  const path = appendLocal(env, record);
  const result = { status: 'saved-local', reason, message: REASON_TEXT[reason] ?? reason, path, id: record.id };
  if (reason === 'gh-not-authenticated') {
    const home = snaglogHome(env);
    const state = readState(home);
    if (!state.authHintShown) {
      result.hint = 'Run `gh auth login` once so snaglog can file approved reports directly.';
      writeState(home, { ...state, authHintShown: true });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Commands

function isUnattended(env) {
  return env.SNAGLOG_UNATTENDED === '1' || (env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0');
}

/** Sanitize and preview. Never writes to GitHub. */
export function prepare(report, env = process.env) {
  const info = skillInfo(report, env);
  const issue = buildIssue(report, info);
  const result = {
    title: issue.title,
    body: issue.body,
    redactions: issue.redactions,
    target: info.repo ? { repo: info.repo, source: info.repoSource } : null,
  };
  if (isUnattended(env)) {
    result.willSaveLocal = 'unattended';
  } else if (!info.repo) {
    result.willSaveLocal = 'no-target';
  } else {
    const check = preflight(info.repo, env);
    if (check.ok) result.target.visibility = check.visibility;
    else result.willSaveLocal = check.reason;
  }
  if (result.willSaveLocal) result.willSaveLocalMessage = REASON_TEXT[result.willSaveLocal];
  else result.approval = approvalToken(info.repo, issue.title, issue.body);
  return result;
}

/** File the approved report, or fall back to the local file. */
export function submit(report, token, env = process.env) {
  const info = skillInfo(report, env);
  const issue = buildIssue(report, info);
  if (isUnattended(env)) return saveLocalRecord(report, info, issue, 'unattended', env);
  if (!info.repo) return saveLocalRecord(report, info, issue, 'no-target', env);
  if (!token || token !== approvalToken(info.repo, issue.title, issue.body)) {
    throw new SnagError('approval token does not match this report; run `prepare` again and show the new text to the user', 3);
  }
  const check = preflight(info.repo, env);
  if (!check.ok) return saveLocalRecord(report, info, issue, check.reason, env);

  const duplicate = findDuplicate(info.repo, report.skill, issue.title, env);
  if (duplicate) {
    const commentBody = `Another occurrence of this snag was reported.\n\n${issue.body}`;
    const r = runGh(env, ['issue', 'comment', String(duplicate.number), '--repo', info.repo, '--body-file', '-'], commentBody);
    if (r.ok) return { status: 'commented', repo: info.repo, number: duplicate.number, url: r.stdout.trim() || duplicate.url };
    return saveLocalRecord(report, info, issue, 'gh-error', env);
  }

  const base = ['issue', 'create', '--repo', info.repo, '--title', issue.title, '--body-file', '-'];
  const labels = ['--label', FRICTION_LABEL, '--label', `skill:${report.skill}`];
  let r = runGh(env, [...base, ...labels], issue.body);
  let labelsOmitted = false;
  if (!r.ok && /label/i.test(r.stderr)) {
    r = runGh(env, base, issue.body);
    labelsOmitted = true;
  }
  if (!r.ok) return saveLocalRecord(report, info, issue, 'gh-error', env);
  const url = r.stdout.trim().split(/\s+/).pop();
  return { status: 'filed', repo: info.repo, url, ...(labelsOmitted ? { labelsOmitted: true } : {}) };
}

/** Keep the sanitized report locally (user declined, or nobody to ask). */
export function saveLocal(report, reason = 'rejected', env = process.env) {
  if (!(reason in REASON_TEXT)) throw new SnagError(`unknown reason "${reason}"; use one of: ${Object.keys(REASON_TEXT).join(', ')}`, 2);
  const info = skillInfo(report, env);
  const issue = buildIssue(report, info);
  return saveLocalRecord(report, info, issue, reason, env);
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--keep-draft') flags.keepDraft = true;
    else if (arg === '--approve' || arg === '--reason') flags[arg.slice(2)] = rest[(i += 1)];
    else throw new SnagError(`unknown option ${arg}`, 2);
  }
  return { command, file, flags };
}

const USAGE = `Usage:
  file-snag.mjs prepare    <report.json>
  file-snag.mjs submit     <report.json> --approve <token> [--keep-draft]
  file-snag.mjs save-local <report.json> [--reason <reason from prepare, or rejected|unattended>] [--keep-draft]`;

export function main(argv, env = process.env) {
  const { command, file, flags } = parseArgs(argv);
  if (!['prepare', 'submit', 'save-local'].includes(command) || !file) throw new SnagError(USAGE, 2);
  const path = resolve(file);
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SnagError(`cannot read report ${file}: ${error.message}`, 2);
  }
  let result;
  if (command === 'prepare') result = prepare(report, env);
  else if (command === 'submit') result = submit(report, flags.approve, env);
  else result = saveLocal(report, flags.reason ?? 'rejected', env);
  if (command !== 'prepare' && !flags.keepDraft) {
    try {
      unlinkSync(path);
    } catch {
      // The draft may already be gone; nothing else depends on it.
    }
  }
  return result;
}

const invokedDirectly =
  process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`file-snag: ${error.message}\n`);
    process.exit(error instanceof SnagError ? error.exitCode : 1);
  }
}

