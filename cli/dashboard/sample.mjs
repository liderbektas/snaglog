// Deterministic sample data for `snaglog dashboard --demo` and the tests:
// a small skills repo with git history plus 35 days of events, snags, evals,
// unsent reports and connection state. Everything is generated; nothing is
// read from the user's machine.
//
// Stories it tells:
//   deploy-preview  broken flag fixed 12 days ago: errors drop, eval rises
//   lint-fix        error rate rising this week, eval score fell, open snags
//   db-migrate      healthy, but every eval case passes
//   release-notes   rarely used; works worse in Codex than in Claude Code

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonLine, writeJson } from '../lib/home.mjs';

const DAY = 24 * 60 * 60 * 1000;

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function git(root, args, date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'snaglog demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'snaglog demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const SKILLS = {
  'deploy-preview': 'Deploy a preview of the current branch.',
  'lint-fix': 'Fix lint errors in changed files.',
  'db-migrate': 'Create and apply database migrations.',
  'release-notes': 'Draft release notes from merged pull requests.',
};

function skillFile(name, body) {
  return `---\nname: ${name}\ndescription: ${SKILLS[name]}\nmetadata:\n  snaglog-repo: acme/skills\n---\n\n# ${name}\n\n${body}\n\nIf this skill doesn't work as described, file a snag with the log-snag skill before working around it.\n`;
}

export function createSample({ home, root, now = Date.now() }) {
  const iso = (t) => new Date(t).toISOString();
  const random = rng(42);

  // Skills repo with SKILL.md history.
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  for (const name of Object.keys(SKILLS)) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), skillFile(name, '1. Run the script with `--env staging`.'));
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'feat: add team skills'], iso(now - 40 * DAY));
  writeFileSync(join(root, 'skills', 'deploy-preview', 'SKILL.md'), skillFile('deploy-preview', '1. Run the script with `--target staging`.'));
  git(root, ['commit', '-q', '-am', 'fix(deploy-preview): use --target instead of --env'], iso(now - 12 * DAY));
  writeFileSync(join(root, 'skills', 'lint-fix', 'SKILL.md'), skillFile('lint-fix', '1. Run the fixer on all files, not only changed ones.'));
  git(root, ['commit', '-q', '-am', 'docs(lint-fix): run the fixer on all files'], iso(now - 6 * DAY));
  const commits = git(root, ['log', '--format=%H']).split('\n'); // newest first
  const [lintChange, deployFix, initial] = commits;

  // Events.
  const errorRate = (skill, agent, t) => {
    const age = (now - t) / DAY;
    if (skill === 'deploy-preview') return age > 12 ? (agent === 'codex' ? 0.55 : 0.4) : 0.05;
    if (skill === 'lint-fix') return age < 6 ? 0.35 : 0.08;
    if (skill === 'release-notes') return agent === 'codex' ? 0.45 : 0.1;
    return 0.04;
  };
  const perDay = { 'deploy-preview': 6, 'lint-fix': 8, 'db-migrate': 3, 'release-notes': 0.6 };
  let session = 0;
  for (let d = 35; d >= 0; d -= 1) {
    for (const [skill, rate] of Object.entries(perDay)) {
      const count = Math.floor(rate + random());
      for (let i = 0; i < count; i += 1) {
        const agent = random() < 0.65 ? 'claude-code' : 'codex';
        const model = agent === 'codex' ? 'gpt-5.5-codex' : 'claude-opus-5-5';
        let t = now - d * DAY - Math.floor(random() * 20 * 60 * 60 * 1000);
        if (t > now) t = now - 60 * 1000;
        const sessionId = `demo${String((session += 1)).padStart(12, '0')}`;
        const base = { agent, model, skill, sessionId };
        const write = (event) => appendJsonLine(join(home, 'events', `${event.time.slice(0, 10)}.jsonl`), event);
        write({ ...base, time: iso(t), kind: 'invoked' });
        const calls = 2 + Math.floor(random() * 4);
        let errors = 0;
        let retries = 0;
        let last = t;
        let lastFailed = false;
        for (let c = 0; c < calls; c += 1) {
          last += 1000 + Math.floor(random() * 4000);
          const failed = random() < errorRate(skill, agent, t);
          if (failed && lastFailed) retries += 1;
          lastFailed = failed;
          if (failed) errors += 1;
          write({ ...base, time: iso(last), kind: failed ? 'error' : 'tool_call', success: !failed, durationMs: 50 + Math.floor(random() * 900) });
        }
        const tokens = 20000 + Math.floor(random() * 60000);
        write({ ...base, time: iso(last + 2000), kind: 'completed', success: errors === 0, durationMs: last + 2000 - t, retries, tokens, ...(agent === 'claude-code' ? { cacheTokens: Math.round(tokens * 0.9), costUsd: Math.round(tokens * 1.5) / 1e6 } : {}) });
      }
    }
  }

  // Snags collected from GitHub.
  writeJson(join(home, 'collected', 'snags', 'acme__skills.json'), {
    repo: 'acme/skills',
    collectedAt: iso(now - 60 * 60 * 1000),
    issues: [
      { number: 42, title: '[snag] deploy-preview: documented --env flag is rejected', skill: 'deploy-preview', state: 'closed', createdAt: iso(now - 30 * DAY), closedAt: iso(now - 12 * DAY), occurrences: 5, url: 'https://github.com/acme/skills/issues/42' },
      { number: 57, title: '[snag] lint-fix: fixer reports success but files are unchanged', skill: 'lint-fix', state: 'open', createdAt: iso(now - 5 * DAY), closedAt: null, occurrences: 3, url: 'https://github.com/acme/skills/issues/57' },
      { number: 58, title: '[snag] lint-fix: fixer runs out of memory on large repos', skill: 'lint-fix', state: 'open', createdAt: iso(now - 2 * DAY), closedAt: null, occurrences: 1, url: 'https://github.com/acme/skills/issues/58' },
      { number: 31, title: '[snag] db-migrate: dry run applies the migration', skill: 'db-migrate', state: 'closed', createdAt: iso(now - 34 * DAY), closedAt: iso(now - 31 * DAY), occurrences: 1, url: 'https://github.com/acme/skills/issues/31' },
      { number: 61, title: '[snag] release-notes: empty list when PRs use squash merges', skill: 'release-notes', state: 'open', createdAt: iso(now - 9 * DAY), closedAt: null, occurrences: 2, url: 'https://github.com/acme/skills/issues/61' },
    ],
  });

  // Eval records.
  const evalRecord = (skill, t, score, commit, { ablation = false, delta = null, cases = 6, allPassed = false } = {}) => {
    writeJson(join(home, 'evals', skill, `${iso(t).replace(/[:.]/g, '-')}.json`), {
      skill, ranAt: iso(t), score, meanDelta: delta, ablation, commit, dirty: false, partial: false, costUsd: 0.04 * cases * (ablation ? 2 : 1), durationSeconds: 120,
      cases: Array.from({ length: cases }, (_, i) => ({ name: `${skill}-case-${i + 1}`, score: i < Math.round(score * cases) ? 1 : 0, delta, errored: false, aborted: false })),
      source: 'snaglog eval', allPassed,
    });
  };
  evalRecord('deploy-preview', now - 20 * DAY, 0.5, initial, { ablation: true, delta: 0.05 });
  evalRecord('deploy-preview', now - 11 * DAY, 0.83, deployFix, { ablation: true, delta: 0.4 });
  evalRecord('lint-fix', now - 15 * DAY, 0.83, initial);
  evalRecord('lint-fix', now - 5 * DAY, 0.67, lintChange);
  evalRecord('db-migrate', now - 8 * DAY, 1, initial, { allPassed: true, cases: 4 });

  // Unsent local reports.
  const report = (id, skill, repo, reason, days, summary) => appendJsonLine(join(home, 'snags.jsonl'), {
    id, savedAt: iso(now - days * DAY), status: 'unsent', reason, skill, repo, agent: 'claude-code', model: 'claude-opus-5-5',
    title: `[snag] ${skill}: ${summary}`,
    body: `**Skill:** \`${skill}\`\n**Agent:** claude-code · **Model:** claude-opus-5-5\n\n### What was attempted\nRan step 2 of the skill.\n\n### Expected\nA list of changed files.\n\n### What happened\n\`\`\`text\nerror: unknown option '--changed'\n\`\`\`\n\n---\n<sub>Filed with the snaglog \`log-snag\` skill after the user reviewed and approved this exact text.</sub>`,
  });
  report('00000000-0000-4000-8000-00000000d001', 'lint-fix', 'acme/skills', 'unattended', 1, 'documented --changed flag is rejected');
  report('00000000-0000-4000-8000-00000000d002', 'release-notes', null, 'no-target', 3, 'template link points to a deleted file');

  writeJson(join(home, 'connections.json'), {
    'claude-code': { lastEventAt: iso(now - 5 * 60 * 1000), connection: { connectedAt: iso(now - 36 * DAY), endpoint: 'http://127.0.0.1:4318', file: '~/.claude/settings.json' } },
    codex: { lastEventAt: iso(now - 3 * DAY), connection: { connectedAt: iso(now - 36 * DAY), endpoint: 'http://127.0.0.1:4318', file: '~/.codex/config.toml' } },
  });
  return { commits: { initial, deployFix, lintChange } };
}
