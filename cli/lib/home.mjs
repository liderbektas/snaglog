// snaglog's data directory (~/.snaglog, or SNAGLOG_HOME). Everything snaglog
// stores lives here, readable only by the current user.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function snaglogHome(env = process.env) {
  return env.SNAGLOG_HOME || join(homedir(), '.snaglog');
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (temp file + rename) with owner-only permissions. */
export function writeJson(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function appendJsonLine(path, value) {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Per-machine random salt; never leaves the machine. */
export function salt(env = process.env) {
  const path = join(snaglogHome(env), 'salt');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const value = randomBytes(32).toString('hex');
  ensureDir(dirname(path));
  writeFileSync(path, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return readFileSync(path, 'utf8').trim();
}

/** Anonymous, stable id for a session id: salted SHA-256, truncated. */
export function anonymize(value, saltValue) {
  return createHash('sha256').update(`${saltValue}:${value}`).digest('hex').slice(0, 16);
}
