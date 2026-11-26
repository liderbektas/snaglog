// `snaglog collect` — refresh snag data from GitHub (read-only) and import
// local eval results. Repos passed with --repo are remembered in
// ~/.snaglog/config.json for the next run.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_NAME } from '../lib/gh.mjs';
import { readJson, snaglogHome, writeJson } from '../lib/home.mjs';
import { collectEvals } from './evals.mjs';
import { collectSnags } from './snags.mjs';

const USAGE = `Usage: snaglog collect [--repo owner/repo]... [--path <skills checkout>]

Reads snag issues from each repo with gh (read-only) and imports results of
\`claude plugin eval\` from <path>/evals/results. Repos are remembered.`;

export async function run(args, io, deps = {}) {
  const env = deps.env ?? process.env;
  let values;
  try {
    ({ values } = parseArgs({ args, options: { repo: { type: 'string', multiple: true }, path: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    io.err(`snaglog collect: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const configFile = join(snaglogHome(env), 'config.json');
  const config = readJson(configFile, {});
  const given = values.repo ?? [];
  for (const repo of given) {
    if (!REPO_NAME.test(repo)) {
      io.err(`snaglog collect: "${repo}" is not owner/repo`);
      return 2;
    }
  }
  const repos = [...new Set([...(config.repos ?? []), ...given])];
  if (given.length) writeJson(configFile, { ...config, repos });

  let failed = 0;
  if (!repos.length) io.out('No repos configured: pass --repo owner/repo to collect snags.');
  for (const repo of repos) {
    try {
      const { issues } = collectSnags(repo, env);
      const open = issues.filter((i) => i.state === 'open').length;
      io.out(`${repo}: ${issues.length} snags (${open} open)`);
    } catch (error) {
      failed += 1;
      io.err(`${repo}: ${error.message}`);
    }
  }

  const root = resolve(values.path ?? process.cwd());
  if (existsSync(join(root, 'evals', 'results'))) {
    const written = collectEvals(root, env);
    io.out(`evals: imported ${written.length} new result${written.length === 1 ? '' : 's'} from ${root}`);
  }
  return failed ? 1 : 0;
}
