import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, COMMANDS } from '../cli/snaglog.mjs';

function capture() {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

test('prints usage with every command', async () => {
  const { io, out } = capture();
  assert.equal(await main([], io), 0);
  for (const name of Object.keys(COMMANDS)) assert.match(out.join('\n'), new RegExp(`\\b${name}\\b`));
});

test('rejects unknown commands with exit code 2', async () => {
  const { io, err } = capture();
  assert.equal(await main(['nope'], io), 2);
  assert.match(err.join('\n'), /unknown command "nope"/);
});

test('every command module loads and exports run()', async () => {
  for (const { module } of Object.values(COMMANDS)) {
    const mod = await import(new URL(`../cli/${module.slice(2)}`, import.meta.url));
    assert.equal(typeof mod.run, 'function', module);
  }
});
