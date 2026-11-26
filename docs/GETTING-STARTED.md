# Getting started: add snaglog to a project

This guide takes one project from zero to a working snaglog loop. The example is a developer, Ayşe, with a GitHub repository `ayse/my-app` that has one project skill.

## 0. Check what you need

```bash
node --version
```

Node.js 22 or later.

```bash
gh auth status
```

You must be logged in to the GitHub CLI (`gh auth login` once if not), with write access to the project's repository: snaglog creates labels there, and approved snag reports become issues there.

```bash
claude --version
```

Claude Code (the terminal app or Claude Code Desktop). Codex works too.

## 1. Install snaglog

```bash
git clone https://github.com/liderbektas/snaglog.git ~/snaglog
```

```bash
cd ~/snaglog && npm link
```

```bash
snaglog --help
```

## 2. Know where your skills are

snaglog watches skills, so the project needs at least one. Claude Code loads a project's skills from `.claude/skills/`:

```text
my-app/
└── .claude/
    └── skills/
        └── deploy/
            └── SKILL.md
```

A dedicated skills repository, with skills in a root-level `skills/` folder, works too; snaglog then keeps evals in `evals/` instead of `.claude/evals/`.

## 3. Wire the project (once)

From the project folder, look at the plan first. Nothing changes:

```bash
snaglog init --repo ayse/my-app --dry-run
```

```text
Planned changes:
  .claude/skills/deploy/SKILL.md  add metadata.snaglog-repo: ayse/my-app
  .claude/skills/deploy/SKILL.md  append the snag reminder line
  .claude/skills/log-snag/        copy bundled skill log-snag
  .claude/skills/fix-snags/       copy bundled skill fix-snags
  .claude/evals/deploy/           create an inactive eval skeleton
  .gitignore                      ignore .claude/evals/results/ (eval results contain transcripts)
  GitHub ayse/my-app              create label skill-friction
  GitHub ayse/my-app              create label skill:deploy
```

Then apply it and answer `y`:

```bash
snaglog init --repo ayse/my-app
```

Commit and push, so everyone on the project gets `log-snag` and `fix-snags` with their next pull:

```bash
git add -A && git commit -m "chore: wire skills to snaglog" && git push
```

## 4. Connect your agent (each developer, once)

```bash
snaglog connect claude-code
```

It shows every change to `~/.claude/settings.json`, asks, and backs the file up first. Restart Claude Code (quit Claude Code Desktop completely and reopen it). For Codex, run `snaglog connect codex`.

## 5. Keep the dashboard running

In its own terminal tab:

```bash
snaglog dashboard --path ~/projects/my-app
```

Open http://127.0.0.1:4747. Telemetry is collected only while this runs.

## 6. Work as usual

Use Claude in the project as you normally would. When it uses `deploy`, the dashboard shows the skill's usage, tool errors, duration and cost. If the skill gets in the way (a documented command fails, a step does nothing), Claude drafts a snag report and asks:

> File this report as an issue in `ayse/my-app` (private)? **File / Edit / Don't file**

Approved reports become issues; repeats of the same problem are added to the open issue as comments. Declined reports stay on your machine and appear under *Unsent reports* in the dashboard.

## 7. Bring snags into the dashboard

```bash
snaglog collect --repo ayse/my-app
```

This only reads from GitHub. Skills with open snags move to the top of the dashboard.

## 8. Fix

Whoever owns the skill asks Claude in the project:

> Use fix-snags to fix the snags of the deploy skill.

Claude groups the reports by cause, asks which fixes to make, edits the skill on a branch (Claude Code asks you to approve each skill-file edit), adds an eval case for each snag, shows the pull request text, and opens the pull request after you approve. Merging is up to you. The dashboard's *Before / after* page then shows whether the change helped.

## 9. Measure with evals (optional, costs money)

Evals use your Claude account. Check the plan and estimate first:

```bash
snaglog eval --dry-run
```

The first run in a project needs your trust, confirmed in a terminal:

```bash
snaglog eval deploy --trust-plugin
```

Each run stops at `--max-cost-usd` (default $1).

## Teammates

Once step 3 is pushed, teammates only do steps 1, 4 and 5: install snaglog, connect their agent, run the dashboard.

## Undo

```bash
snaglog disconnect claude-code
```

To undo the project changes, revert the commit from step 3. The two labels stay on GitHub until you delete them.

## If nothing shows up

Open the dashboard's *Connections* page: it shows whether your agent is connected, when its last event arrived and what to check. The most common causes are a Claude Code that was not restarted after `connect`, and a dashboard that was not running.
