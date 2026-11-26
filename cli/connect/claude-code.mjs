// Claude Code: route log events to snaglog through the user-level settings
// file (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json) and
// install the skill-name hook. Only log-specific exporter variables are set,
// so metrics or traces the user already sends elsewhere are left alone.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const name = 'claude-code';

export function configPath(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

export function envSettings(endpoint) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
    // Never send prompt text, responses, tool details or request bodies.
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_TOOL_CONTENT: '0',
    OTEL_LOG_RAW_API_BODIES: '0',
  };
}

const HOOK_EVENTS = [
  { event: 'PreToolUse', matcher: 'Skill' },
  { event: 'UserPromptExpansion' },
];

function hookEntry(command) {
  return { type: 'command', command, async: true, timeout: 10 };
}

// snaglog's hook is recognised by its script path, so a changed node path
// updates the entry instead of adding a second one.
function ourHooks(settings, event, target) {
  return (settings.hooks?.[event] ?? []).flatMap((group) => (group.hooks ?? []).filter((h) => typeof h.command === 'string' && h.command.includes(target)));
}

function managedSettingsPath() {
  if (platform() === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform() === 'linux') return '/etc/claude-code/managed-settings.json';
  return undefined;
}

function parse(text, path) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new Error(`${path} is not a JSON object; fix it before connecting`);
}

/** Plan the change. Returns { text, lines, warnings, record } or { nothing: true }. */
export function plan({ text, path, endpoint, hookCommand, hookTarget = hookCommand }) {
  const settings = text === undefined ? {} : parse(text, path);
  const before = JSON.stringify(settings);
  const lines = [];
  const warnings = [];
  const previous = {};
  const env = { ...(settings.env ?? {}) };

  for (const [key, value] of Object.entries(envSettings(endpoint))) {
    if (env[key] === value) continue;
    previous[key] = env[key] ?? null;
    if (env[key] === undefined) lines.push(`env.${key}: (unset) → ${value}`);
    else lines.push(`env.${key}: ${env[key]} → ${value}`);
    if (key === 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT' && env[key]) warnings.push(`log events currently go to ${env[key]}; after connecting they go to snaglog instead`);
    env[key] = value;
  }
  if (settings.env?.OTEL_EXPORTER_OTLP_ENDPOINT && !settings.env?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    warnings.push(`logs currently follow OTEL_EXPORTER_OTLP_ENDPOINT (${settings.env.OTEL_EXPORTER_OTLP_ENDPOINT}); after connecting, only logs go to snaglog and other signals are unchanged`);
  }
  settings.env = env;

  const hooksAdded = [];
  for (const { event, matcher } of HOOK_EVENTS) {
    const existing = ourHooks(settings, event, hookTarget);
    if (existing.length) {
      for (const h of existing.filter((x) => x.command !== hookCommand)) {
        h.command = hookCommand;
        lines.push(`hooks.${event}: update the snaglog hook command`);
      }
      continue;
    }
    settings.hooks ??= {};
    settings.hooks[event] ??= [];
    settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [hookEntry(hookCommand)] });
    hooksAdded.push(event);
    lines.push(`hooks.${event}${matcher ? ` (matcher ${matcher})` : ''}: add snaglog skill-name hook`);
  }

  const managed = managedSettingsPath();
  if (managed && existsSync(managed)) {
    try {
      if (/OTEL_/.test(readFileSync(managed, 'utf8'))) warnings.push(`managed settings (${managed}) set OpenTelemetry variables and may override these`);
    } catch {
      // Unreadable managed settings: nothing to report.
    }
  }

  if (JSON.stringify(settings) === before) return { nothing: true, warnings };
  return {
    text: `${JSON.stringify(settings, null, 2)}\n`,
    lines,
    warnings,
    record: { previous, hooksAdded, hookCommand, hookTarget, envCreated: !('env' in (text === undefined ? {} : parse(text, path))) },
  };
}

/** Undo only snaglog's keys in a settings file that changed after connecting. */
export function revert({ text, path, record, endpoint }) {
  const settings = parse(text, path);
  const ours = envSettings(endpoint);
  if (settings.env) {
    for (const [key, prev] of Object.entries(record.previous ?? {})) {
      if (settings.env[key] !== ours[key]) continue; // changed by the user since: theirs now
      if (prev === null) delete settings.env[key];
      else settings.env[key] = prev;
    }
    if (record.envCreated && Object.keys(settings.env).length === 0) delete settings.env;
  }
  for (const event of record.hooksAdded ?? []) {
    const groups = settings.hooks?.[event];
    if (!groups) continue;
    settings.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !(typeof h.command === 'string' && h.command.includes(record.hookTarget ?? record.hookCommand))) }))
      .filter((g) => g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export const notes = ['Restart Claude Code for the change to take effect.'];
