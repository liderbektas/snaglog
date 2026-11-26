// Unsent snag reports (~/.snaglog/snags.jsonl) as the dashboard edits them.
// Edits are re-sanitized. Sending needs the approval token of the exact
// title, body and repo the user is looking at, so a stale page cannot send
// text the user has not seen. Sending goes through the same fileIssue() the
// log-snag skill uses.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalToken, fileIssue, neutralizeMentions, sanitize } from '../../skills/log-snag/scripts/file-snag.mjs';
import { REPO_NAME } from '../lib/gh.mjs';

const LIMIT = { title: 200, body: 20000 };

function file(home) {
  return join(home, 'snags.jsonl');
}

function readAll(home) {
  if (!existsSync(file(home))) return [];
  return readFileSync(file(home), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { _raw: l };
      }
    });
}

function writeAll(home, records) {
  const tmp = `${file(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, records.map((r) => (r._raw !== undefined ? r._raw : JSON.stringify(r))).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
  renameSync(tmp, file(home));
}

function view(record) {
  const { id, savedAt, reason, skill, repo, agent, model, title, body } = record;
  return { id, savedAt, reason, skill, repo: repo ?? null, agent, model, title, body, approval: repo ? approvalToken(repo, title, body) : null };
}

export function listUnsent(home) {
  return readAll(home).filter((r) => r.status === 'unsent' && r.id).map(view);
}

function clean(text, max) {
  return neutralizeMentions(sanitize(String(text ?? '')).text).slice(0, max);
}

export function updateReport(home, id, { title, body, repo }) {
  const records = readAll(home);
  const record = records.find((r) => r.id === id && r.status === 'unsent');
  if (!record) return { error: 'not found', status: 404 };
  if (repo !== undefined && repo !== null && repo !== '' && !REPO_NAME.test(repo)) return { error: 'repo must be owner/repo', status: 400 };
  if (title !== undefined) {
    const t = clean(title, LIMIT.title).replace(/\s+/g, ' ').trim();
    if (!t) return { error: 'title is required', status: 400 };
    record.title = t.startsWith(`[snag] ${record.skill}:`) ? t : `[snag] ${record.skill}: ${t.replace(/^\[snag\][^:]*:\s*/, '')}`;
  }
  if (body !== undefined) record.body = clean(body, LIMIT.body);
  if (repo !== undefined) record.repo = repo || null;
  record.editedAt = new Date().toISOString();
  writeAll(home, records);
  return { report: view(record) };
}

export function deleteReport(home, id) {
  const records = readAll(home);
  const next = records.filter((r) => !(r.id === id && r.status === 'unsent'));
  if (next.length === records.length) return { error: 'not found', status: 404 };
  writeAll(home, next);
  return { deleted: id };
}

export function sendReport(home, id, approval, env = process.env) {
  const records = readAll(home);
  const record = records.find((r) => r.id === id && r.status === 'unsent');
  if (!record) return { error: 'not found', status: 404 };
  if (!record.repo) return { error: 'choose a target repo first', status: 400 };
  if (approval !== approvalToken(record.repo, record.title, record.body)) {
    return { error: 'this report changed since you looked at it; reload and review it again', status: 409 };
  }
  const result = fileIssue({ repo: record.repo, skill: record.skill, title: record.title, body: record.body }, env);
  if (result.status === 'failed') {
    record.reason = result.reason;
    writeAll(home, records);
    return { error: `not sent: ${result.reason}`, status: 502 };
  }
  record.status = 'sent';
  record.sentAt = new Date().toISOString();
  record.url = result.url;
  writeAll(home, records);
  return { sent: { status: result.status, url: result.url } };
}
