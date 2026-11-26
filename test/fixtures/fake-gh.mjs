#!/usr/bin/env node
// Stand-in for the GitHub CLI in tests. It never touches the network: it
// records every call to FAKE_GH_LOG and answers from FAKE_GH_SCENARIO (JSON).
//
// Scenario keys (all optional):
//   auth: false            -> `gh auth status` fails
//   repo: { exists, visibility, hasIssuesEnabled }
//   issues: [{ number, title, url }]   -> returned by `gh issue list`
//   labelIssues: [...]     -> returned by `gh issue list --label ...` (defaults to issues)
//   listFails: true        -> `gh issue list` fails
//   labelsMissing: true    -> `gh issue create --label ...` fails like gh does
//   createFails: true      -> every `gh issue create` fails
//   labels: ['name', ...]  -> returned by `gh label list`
//   labelCreateFails: true -> every `gh label create` fails

import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(process.env.FAKE_GH_SCENARIO || '{}');
const args = process.argv.slice(2);
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  // No stdin attached.
}
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ args, stdin })}\n`);

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const [a, b] = args;

if (a === '--version') {
  process.stdout.write('gh version 0.0.0-fake\n');
} else if (a === 'auth' && b === 'status') {
  if (scenario.auth === false) fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
} else if (a === 'repo' && b === 'view') {
  const repo = scenario.repo ?? {};
  if (repo.exists === false) fail(`GraphQL: Could not resolve to a Repository with the name '${args[2]}'.`);
  process.stdout.write(
    JSON.stringify({ nameWithOwner: args[2], visibility: repo.visibility ?? 'PRIVATE', hasIssuesEnabled: repo.hasIssuesEnabled ?? true }),
  );
} else if (a === 'issue' && b === 'list') {
  if (scenario.listFails) fail('HTTP 404: Not Found');
  const issues = args.includes('--label') ? (scenario.labelIssues ?? scenario.issues) : scenario.issues;
  process.stdout.write(JSON.stringify(issues ?? []));
} else if (a === 'issue' && b === 'create') {
  if (scenario.createFails) fail('HTTP 502: Bad Gateway');
  if (scenario.labelsMissing && args.includes('--label')) fail("could not add label: 'skill-friction' not found");
  process.stdout.write(`https://github.com/${flag('--repo')}/issues/101\n`);
} else if (a === 'label' && b === 'list') {
  process.stdout.write(JSON.stringify((scenario.labels ?? []).map((name) => ({ name }))));
} else if (a === 'label' && b === 'create') {
  if (scenario.labelCreateFails) fail('HTTP 403: Resource not accessible by integration');
  process.stdout.write('');
} else if (a === 'issue' && b === 'comment') {
  process.stdout.write(`https://github.com/${flag('--repo')}/issues/${args[2]}#issuecomment-1\n`);
} else {
  fail(`fake-gh: unexpected command: ${args.join(' ')}`);
}
