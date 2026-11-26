// Shared connect / disconnect flow: plan, show, confirm, back up, apply, and
// the exact reverse. State lives in ~/.snaglog/connections.json.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { confirm } from '../lib/confirm.mjs';
import { ensureDir, readJson, snaglogHome, writeJson } from '../lib/home.mjs';
import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';

export const AGENTS = { 'claude-code': claudeCode, codex };
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318';
const HOOK_SOURCE = fileURLToPath(new URL('./hooks/claude-skill-hint.mjs', import.meta.url));
export const UNSUPPORTED = {
  copilot: 'GitHub Copilot support is planned for a later release.',
  opencode: 'OpenCode has no official native OpenTelemetry export yet.',
  cursor: 'Cursor has no official local OpenTelemetry export.',
  gemini: 'Gemini CLI support is planned for a later release.',
  chatgpt: 'ChatGPT (web/desktop) has no telemetry export and cannot be supported.',
};

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function parse(command, args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      endpoint: { type: 'string' },
      token: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { values, agentName: positionals[0], usage: usage(command) };
}

export function usage(command) {
  return `Usage: snaglog ${command} <agent> [--dry-run] [--yes]${command === 'connect' ? ' [--endpoint http://127.0.0.1:<port>]' : ''}

Agents: ${Object.keys(AGENTS).join(', ')}
Every change is shown first and needs confirmation; the previous file is backed up
to ~/.snaglog/backups/ and \`snaglog disconnect <agent>\` restores it.`;
}

export function resolveAgent(name, io) {
  if (AGENTS[name]) return AGENTS[name];
  if (UNSUPPORTED[name]) io.err(`snaglog: ${name} is not supported. ${UNSUPPORTED[name]}`);
  else io.err(`snaglog: unknown agent "${name ?? ''}". Supported: ${Object.keys(AGENTS).join(', ')}`);
  return undefined;
}

export function checkEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`--endpoint "${endpoint}" is not a URL`);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('--endpoint must be http://127.0.0.1:<port>; team mode (remote endpoints with a token) is not available yet');
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * The node binary for the hook command: the first `node` on PATH (usually a
 * stable link such as /opt/homebrew/bin/node) rather than process.execPath,
 * which can be a versioned path that disappears on upgrade.
 */
function nodeBinary(env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return process.execPath;
}

export function hookPaths(env) {
  const target = join(snaglogHome(env), 'hooks', 'claude-skill-hint.mjs');
  return { source: HOOK_SOURCE, target, command: `"${nodeBinary(env)}" "${target}"` };
}

/** True when the installed hook script differs from the one in this snaglog. */
export function hookOutdated(env) {
  const { source, target } = hookPaths(env);
  return !existsSync(target) || !readFileSync(target).equals(readFileSync(source));
}

export function state(env) {
  const file = join(snaglogHome(env), 'connections.json');
  return {
    read: () => readJson(file, {}),
    write: (value) => writeJson(file, value),
  };
}

export async function ask(values, deps, io, question) {
  if (values.yes) return true;
  const answer = await (deps.confirm ?? ((q) => confirm(q)))(question);
  if (answer === null) {
    io.err('snaglog: no terminal to confirm; review with --dry-run, then re-run with --yes');
    return false;
  }
  if (!answer) io.out('Cancelled: nothing was changed.');
  return answer;
}

export function backup(env, agent, path) {
  const dir = ensureDir(join(snaglogHome(env), 'backups'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(dir, `${agent}-${stamp}-${path.split(/[\\/]/).pop()}`);
  copyFileSync(path, target);
  return target;
}

export function writeConfig(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function installHook(env) {
  const { source, target } = hookPaths(env);
  ensureDir(dirname(target));
  writeFileSync(target, readFileSync(source), { mode: 0o700 });
}

export function removeHook(env) {
  rmSync(hookPaths(env).target, { force: true });
}

export { existsSync, readFileSync, rmSync };
