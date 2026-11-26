// `snaglog connect <agent>` — route an agent's telemetry to the local
// snaglog receiver. Shows every change, asks, backs up, then writes.

import { ask, backup, checkEndpoint, DEFAULT_ENDPOINT, existsSync, hookPaths, installHook, parse, readFileSync, resolveAgent, sha256, state, writeConfig } from './common.mjs';

export async function run(args, io, deps = {}) {
  const env = deps.env ?? process.env;
  let parsed;
  try {
    parsed = parse('connect', args);
  } catch (error) {
    io.err(`snaglog connect: ${error.message}`);
    return 2;
  }
  const { values, agentName, usage } = parsed;
  if (values.help || !agentName) {
    (values.help ? io.out : io.err)(usage);
    return values.help ? 0 : 2;
  }
  const agent = resolveAgent(agentName, io);
  if (!agent) return 2;
  if (values.token) {
    io.err('snaglog connect: --token is for team mode, which is not available yet');
    return 2;
  }

  let endpoint;
  try {
    endpoint = checkEndpoint(values.endpoint ?? DEFAULT_ENDPOINT);
  } catch (error) {
    io.err(`snaglog connect: ${error.message}`);
    return 2;
  }

  const path = agent.configPath(env);
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, 'utf8') : undefined;
  const hook = hookPaths(env);
  let plan;
  try {
    plan = agent.plan({ text: original, path, endpoint, hookCommand: hook.command });
  } catch (error) {
    io.err(`snaglog connect: ${error.message}`);
    return 1;
  }

  io.out(`snaglog connect ${agent.name} → ${endpoint}`);
  io.out(`Settings file: ${path}${existed ? '' : ' (will be created)'}`);
  for (const warning of plan.warnings) io.out(`warning: ${warning}`);
  const connections = state(env).read();
  if (plan.nothing) {
    io.out('Nothing to do: already connected.');
    return 0;
  }
  io.out('\nPlanned changes:');
  for (const line of plan.lines) io.out(`  ${line}`);
  if (agent.name === 'claude-code') io.out(`  install hook script: ${hook.target}`);
  io.out(existed ? '\nThe current file will be backed up first.' : '');

  if (values['dry-run']) {
    io.out('Dry run: nothing was changed.');
    return 0;
  }
  if (!(await ask(values, deps, io, 'Apply these changes?'))) return 1;

  const backupPath = existed ? backup(env, agent.name, path) : undefined;
  if (agent.name === 'claude-code') installHook(env);
  writeConfig(path, plan.text);

  const prior = connections[agent.name]?.connection;
  connections[agent.name] = {
    ...(connections[agent.name] ?? {}),
    connection: {
      connectedAt: new Date().toISOString(),
      endpoint,
      file: path,
      existed: prior ? prior.existed : existed,
      backup: prior?.backup ?? backupPath,
      writtenHash: sha256(plan.text),
      // After a second connect the backup predates edits made in between, so an
      // exact restore could lose them; disconnect then reverts key by key.
      exactRestore: prior ? false : true,
      record: prior ? mergeRecords(prior.record, plan.record) : plan.record,
    },
  };
  state(env).write(connections);

  io.out(`\nConnected ${agent.name}.${backupPath ? ` Backup: ${backupPath}` : ''}`);
  for (const note of agent.notes) io.out(note);
  return 0;
}

// Connecting twice keeps the very first "previous" values, so disconnect
// always returns to the state from before snaglog touched the file.
function mergeRecords(first = {}, next = {}) {
  return {
    ...next,
    ...first,
    previous: { ...(next.previous ?? {}), ...(first.previous ?? {}) },
    hooksAdded: [...new Set([...(first.hooksAdded ?? []), ...(next.hooksAdded ?? [])])],
  };
}
