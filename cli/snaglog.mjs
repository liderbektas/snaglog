#!/usr/bin/env node
// snaglog command entry point. Each command lives in its own module and is
// loaded lazily so that `snaglog --help` stays fast and dependency-free.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const COMMANDS = {
  init: { module: './init.mjs', summary: 'Wire a skills repo to snaglog (frontmatter, labels, bundled skills)' },
  connect: { module: './connect/index.mjs', summary: "Route an agent's telemetry to snaglog" },
  disconnect: { module: './connect/disconnect.mjs', summary: 'Undo `snaglog connect` for an agent' },
  collect: { module: './collect/index.mjs', summary: 'Collect snag and eval data into .snaglog/' },
  eval: { module: './eval.mjs', summary: 'Run Claude Code evals for a skill and record the result' },
  dashboard: { module: './dashboard/server.mjs', summary: 'Start the OTLP receiver and dashboard on 127.0.0.1' },
};

export function usage() {
  const lines = ['Usage: snaglog <command> [options]', '', 'Commands:'];
  for (const [name, { summary }] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(12)} ${summary}`);
  }
  lines.push('', 'Run `snaglog <command> --help` for command options.');
  return lines.join('\n');
}

function version() {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

export async function main(argv, io = { out: console.log, err: console.error }) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.out(usage());
    return 0;
  }
  if (command === '--version' || command === '-v') {
    io.out(version());
    return 0;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    io.err(`snaglog: unknown command "${command}"\n\n${usage()}`);
    return 2;
  }
  const mod = await import(new URL(entry.module, import.meta.url));
  return (await mod.run(rest, io)) ?? 0;
}

// Resolve symlinks: npm installs `bin` entries as links to this file.
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`snaglog: ${error.message}`);
      process.exit(1);
    },
  );
}
