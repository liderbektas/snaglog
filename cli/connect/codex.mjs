// Codex: point the `[otel]` log exporter at snaglog in ~/.codex/config.toml
// (or $CODEX_HOME/config.toml). Only the keys snaglog owns are set; other
// keys in `[otel]` are kept. Without a TOML library the edit is line-based
// and deliberately conservative: anything unusual makes it refuse.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'codex';

export function configPath(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
}

export function ownedKeys(endpoint) {
  return {
    exporter: `{ otlp-http = { endpoint = "${endpoint}/v1/logs", protocol = "json" } }`,
    log_user_prompt: 'false',
  };
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

/** Locate the [otel] table: { start, end } line indexes (end exclusive), or undefined. */
function findOtel(lines) {
  let start;
  for (let i = 0; i < lines.length; i += 1) {
    const header = HEADER.exec(lines[i]);
    if (!header) continue;
    const table = header[1];
    if (start === undefined && table === 'otel') start = i;
    else if (start !== undefined && table !== 'otel' && !table.startsWith('otel.')) return { start, end: i };
  }
  return start === undefined ? undefined : { start, end: lines.length };
}

function checkSupported(lines) {
  const firstTable = lines.findIndex((l) => HEADER.test(l));
  const root = firstTable === -1 ? lines : lines.slice(0, firstTable);
  if (root.some((l) => /^\s*otel\s*(=|\.)/.test(l))) throw new Error('config.toml sets otel as a root key; edit it by hand (see docs/AGENT-ADAPTERS.md)');
  if (lines.some((l) => /^\s*\[\s*otel\.exporter\b/.test(l))) throw new Error('config.toml defines [otel.exporter.*] tables; edit it by hand (see docs/AGENT-ADAPTERS.md)');
}

export function plan({ text = '', endpoint }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  checkSupported(lines);
  const keys = ownedKeys(endpoint);
  const changes = [];
  const warnings = [];
  const previous = {};
  let section = findOtel(lines);

  if (!section) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('[otel]');
    section = { start: lines.length - 1, end: lines.length };
    changes.push('[otel]: add table');
  }

  for (const [key, value] of Object.entries(keys)) {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`);
    let found = -1;
    for (let i = section.start + 1; i < section.end; i += 1) {
      if (HEADER.test(lines[i])) break; // stop at a sub-table such as [otel.something]
      if (re.test(lines[i])) found = i;
    }
    const line = `${key} = ${value}`;
    if (found !== -1) {
      if (lines[found].trim() === line) continue;
      previous[key] = lines[found];
      if (key === 'exporter') warnings.push(`Codex log events currently go to: ${re.exec(lines[found])[1]}; after connecting they go to snaglog instead`);
      lines[found] = line;
      changes.push(`[otel] ${key}: ${re.exec(previous[key])[1]} → ${value}`);
    } else {
      previous[key] = null;
      lines.splice(section.start + 1, 0, line);
      section.end += 1;
      changes.push(`[otel] ${key}: (unset) → ${value}`);
    }
  }

  if (!changes.length) return { nothing: true, warnings };
  return { text: `${lines.join(eol)}${eol}`, lines: changes, warnings, record: { previous } };
}

/** Undo only snaglog's keys if the user edited config.toml after connecting. */
export function revert({ text, record, endpoint }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const section = findOtel(lines);
  if (!section) return text;
  const keys = ownedKeys(endpoint);
  for (const [key, prev] of Object.entries(record.previous ?? {})) {
    const ours = `${key} = ${keys[key]}`;
    const index = lines.findIndex((l, i) => i > section.start && i < section.end && l.trim() === ours);
    if (index === -1) continue; // changed by the user since: theirs now
    if (prev === null) {
      lines.splice(index, 1);
      section.end -= 1;
    } else lines[index] = prev;
  }
  const body = lines.slice(section.start + 1, section.end).filter((l) => l.trim() !== '');
  if (body.length === 0) {
    lines.splice(section.start, section.end - section.start);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  return lines.length ? `${lines.join(eol)}${eol}` : '';
}

export const notes = [
  'Restart Codex for the change to take effect.',
  'Codex separately sends usage metrics to OpenAI by default ([otel] metrics_exporter = "statsig", following analytics.enabled). snaglog does not change that; set metrics_exporter = "none" yourself to stop it.',
];
