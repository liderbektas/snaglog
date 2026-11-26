#!/usr/bin/env node
// Stand-in for `git push` in tests (via SNAGLOG_GIT): records the arguments to
// FAKE_GIT_LOG and never contacts a remote. FAKE_GIT_FAIL=1 makes it fail.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_GIT_LOG) appendFileSync(process.env.FAKE_GIT_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
if (process.env.FAKE_GIT_FAIL === '1') {
  process.stderr.write('fatal: could not read from remote repository\n');
  process.exit(128);
}
