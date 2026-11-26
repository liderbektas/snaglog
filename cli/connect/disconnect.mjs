// `snaglog disconnect <agent>` — undo `snaglog connect`. If the settings file
// is exactly as connect left it, the original bytes are restored (or the file
// is removed if connect created it). Otherwise only snaglog's own keys are
// reverted and the user's later edits are kept.

import { ask, existsSync, parse, readFileSync, removeHook, resolveAgent, rmSync, sha256, state, writeConfig } from './common.mjs';

export async function run(args, io, deps = {}) {
  const env = deps.env ?? process.env;
  let parsed;
  try {
    parsed = parse('disconnect', args);
  } catch (error) {
    io.err(`snaglog disconnect: ${error.message}`);
    return 2;
  }
  const { values, agentName, usage } = parsed;
  if (values.help || !agentName) {
    (values.help ? io.out : io.err)(usage);
    return values.help ? 0 : 2;
  }
  const agent = resolveAgent(agentName, io);
  if (!agent) return 2;

  const connections = state(env).read();
  const connection = connections[agent.name]?.connection;
  if (!connection) {
    io.out(`${agent.name} is not connected by snaglog; nothing to do.`);
    return 0;
  }
  const { file, existed, backup, writtenHash, record, endpoint, exactRestore = true } = connection;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const untouched = exactRestore && current !== undefined && sha256(current) === writtenHash;

  let action;
  let next;
  if (current === undefined) {
    action = 'the settings file no longer exists; only snaglog state is cleared';
  } else if (untouched) {
    action = existed ? `restore ${file} exactly from ${backup}` : `remove ${file} (snaglog created it)`;
  } else {
    try {
      next = agent.revert({ text: current, path: file, record, endpoint });
    } catch (error) {
      io.err(`snaglog disconnect: ${error.message}. Restore by hand from ${backup ?? 'your own copy'}.`);
      return 1;
    }
    action = `${file} changed since connecting: revert only snaglog's settings and keep your later edits`;
  }

  io.out(`snaglog disconnect ${agent.name}`);
  io.out(`Planned: ${action}`);
  if (agent.name === 'claude-code') io.out('Planned: remove the snaglog hook script');
  if (values['dry-run']) {
    io.out('Dry run: nothing was changed.');
    return 0;
  }
  if (!(await ask(values, deps, io, 'Apply?'))) return 1;

  if (current !== undefined) {
    if (untouched && existed) writeConfig(file, readFileSync(backup));
    else if (untouched) rmSync(file);
    else if (next === '') rmSync(file);
    else writeConfig(file, next);
  }
  if (agent.name === 'claude-code') removeHook(env);
  const { connection: _removed, ...rest } = connections[agent.name];
  connections[agent.name] = rest;
  state(env).write(connections);
  io.out(`Disconnected ${agent.name}.${backup ? ` The backup stays at ${backup}.` : ''}`);
  return 0;
}
