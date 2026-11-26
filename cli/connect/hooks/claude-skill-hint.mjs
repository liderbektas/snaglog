#!/usr/bin/env node
// snaglog skill-name hook for Claude Code.
//
// Claude Code's telemetry names custom skills only "custom_skill". This hook
// runs on PreToolUse (matcher "Skill") and UserPromptExpansion, reads the
// skill or command name from the hook input on stdin, and appends one line to
// ~/.snaglog/hints/claude-code.jsonl:
//
//   {"t": <epoch ms>, "s": "<hashed session id>", "p": "<hashed prompt id>", "k": "<skill name>"}
//
// It never reads prompt text or tool arguments other than the skill name,
// never uses the network, prints nothing (UserPromptSubmit-style output would
// reach the model's context) and always exits 0 so it can never block Claude.
// Installed by `snaglog connect claude-code`; removed by `disconnect`.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

function home() {
  return process.env.SNAGLOG_HOME || join(homedir(), '.snaglog');
}

function salt(dir) {
  const path = join(dir, 'salt');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch {
      // Another process created it first.
    }
    return readFileSync(path, 'utf8').trim();
  }
}

const hash = (value, s) => createHash('sha256').update(`${s}:${value}`).digest('hex').slice(0, 16);

/** Pick the skill name out of the hook input, or undefined. Exported for tests. */
export function skillNameFrom(input) {
  if (!input || typeof input !== 'object') return undefined;
  let candidate;
  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Skill') {
    const ti = input.tool_input ?? {};
    candidate = ti.skill ?? ti.skill_name ?? ti.name ?? ti.command;
  } else if (input.hook_event_name === 'UserPromptExpansion') {
    candidate = input.command_name;
  }
  if (typeof candidate !== 'string') return undefined;
  const name = candidate.replace(/^\//, '').trim();
  if (!NAME.test(name)) return undefined;
  // Drop a plugin namespace ("team-skills:count-lines" → "count-lines").
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) || undefined : name;
}

export function record(input, dir = home()) {
  const skill = skillNameFrom(input);
  if (!skill || typeof input.session_id !== 'string') return false;
  const s = salt(dir);
  const line = { t: Date.now(), s: hash(input.session_id, s), k: skill };
  if (typeof input.prompt_id === 'string') line.p = hash(input.prompt_id, s);
  mkdirSync(join(dir, 'hints'), { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'hints', 'claude-code.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return true;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    record(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    // Never fail the agent because of telemetry.
  }
  process.exit(0);
}
