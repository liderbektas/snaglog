#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. It makes no model calls and costs
// nothing: `--version` prints a version, `plugin eval` records its arguments
// to FAKE_CLAUDE_LOG and writes a result shaped like the documented
// aggregate-result.json, controlled by FAKE_CLAUDE_SCENARIO (JSON):
//   version: "2.1.291"      -> printed by --version
//   exit: 0                 -> exit code of `plugin eval`
//   noResult: true          -> write no result file
//   cases: [{ name, score, delta, error }]
//   costUsd, partial

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = JSON.parse(process.env.FAKE_CLAUDE_SCENARIO || '{}');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

if (args[0] === '--version') {
  process.stdout.write(`${scenario.version ?? '2.1.291'} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] !== 'plugin' || args[1] !== 'eval') {
  process.stderr.write(`fake-claude: unexpected command ${args.join(' ')}\n`);
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(args)}\n`);

if (!scenario.noResult) {
  const result = {
    schemaVersion: 1,
    partial: Boolean(scenario.partial),
    claudeVersion: scenario.version ?? '2.1.291',
    costUsd: scenario.costUsd ?? 0.12,
    durationSeconds: 30,
    config: { prompt: 'SECRET PROMPT TEXT' },
    aggregates: { overallScore: 0.5 },
    cases: (scenario.cases ?? []).map((c) => ({
      name: c.name,
      aggregates: { score: c.score, delta: c.delta ?? null },
      arms: { with: [{ error: c.error ?? null, aborted: false, transcript: 'SECRET TRANSCRIPT', graders: [{ explanation: 'SECRET EXPLANATION' }] }] },
    })),
  };
  const json = flag('--json');
  const out = flag('--output-dir');
  if (json) writeFileSync(json, JSON.stringify(result));
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'aggregate-result.json'), JSON.stringify(result));
    writeFileSync(join(out, 'report.html'), '<html>SECRET REPORT</html>');
  }
}
process.exit(scenario.exit ?? 0);
