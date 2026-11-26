// Per-skill metrics for the dashboard, computed from SkillEvents, collected
// snags, eval records and local reports. Pure functions: easy to test.

const DAY = 24 * 60 * 60 * 1000;
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const ratio = (a, b) => (b ? a / b : null);

/** Reliability, cost and usage numbers for a list of events. */
export function summarize(events) {
  const invoked = events.filter((e) => e.kind === 'invoked');
  const calls = events.filter((e) => e.kind === 'tool_call' || e.kind === 'error');
  const errors = events.filter((e) => e.kind === 'error');
  const completed = events.filter((e) => e.kind === 'completed');
  return {
    invocations: invoked.length,
    toolCalls: calls.length,
    errors: errors.length,
    errorRate: ratio(errors.length, calls.length),
    runs: completed.length,
    cleanRate: ratio(completed.filter((e) => e.success).length, completed.length),
    avgRetries: mean(completed.map((e) => e.retries ?? 0)),
    avgDurationMs: mean(completed.map((e) => e.durationMs).filter((v) => typeof v === 'number')),
    avgTokens: mean(completed.map((e) => e.tokens).filter((v) => typeof v === 'number')),
    // Older events (before cache tokens were recorded separately) have none.
    avgCacheTokens: mean(completed.map((e) => e.cacheTokens).filter((v) => typeof v === 'number')),
    avgCostUsd: mean(completed.map((e) => e.costUsd).filter((v) => typeof v === 'number')),
  };
}

function snagSummary(snags, reports) {
  const open = snags.filter((s) => s.state === 'open');
  const closed = snags.filter((s) => s.state === 'closed' && s.closedAt);
  const fixDays = closed.map((s) => (Date.parse(s.closedAt) - Date.parse(s.createdAt)) / DAY).filter((d) => d >= 0);
  return {
    open: open.length,
    closed: closed.length,
    occurrences: snags.reduce((sum, s) => sum + (s.occurrences ?? 1), 0),
    avgFixDays: mean(fixDays),
    unsent: reports.filter((r) => r.status === 'unsent').length,
  };
}

function evalSummary(records = []) {
  const last = records.at(-1);
  const previous = records.at(-2);
  const ablated = [...records].reverse().find((r) => r.ablation && typeof r.meanDelta === 'number');
  return {
    runs: records.length,
    lastScore: last?.score ?? null,
    previousScore: previous?.score ?? null,
    lastRanAt: last?.ranAt ?? null,
    lastCommit: last?.commit ?? null,
    ablationDelta: ablated?.meanDelta ?? null,
    allPassed: Boolean(last?.allPassed),
  };
}

function within(events, from, to) {
  return events.filter((e) => {
    const t = Date.parse(e.time);
    return t >= from && t < to;
  });
}

function bySkill(list, key = 'skill') {
  const map = new Map();
  for (const item of list) {
    const name = item[key];
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(item);
  }
  return map;
}

/** Why a skill needs attention, highest weight first. */
function attention({ snags, evals, recent, previous }) {
  const reasons = [];
  let score = 0;
  if (snags.open) {
    reasons.push(`${snags.open} open snag${snags.open > 1 ? 's' : ''}`);
    score += snags.open * 3 + (snags.occurrences - snags.open - snags.closed);
  }
  if (evals.lastScore !== null && evals.previousScore !== null && evals.lastScore < evals.previousScore - 0.001) {
    reasons.push(`eval score fell ${pct(evals.previousScore)} → ${pct(evals.lastScore)}`);
    score += 5 + (evals.previousScore - evals.lastScore) * 10;
  }
  // Both weeks need enough tool calls, or a rarely used skill looks alarming.
  if (recent.toolCalls >= 5 && previous.toolCalls >= 5 && recent.errorRate > previous.errorRate + 0.05) {
    reasons.push(`error rate rising ${pct(previous.errorRate)} → ${pct(recent.errorRate)}`);
    score += 3 + recent.errorRate * 10;
  }
  if (snags.unsent) {
    reasons.push(`${snags.unsent} unsent report${snags.unsent > 1 ? 's' : ''}`);
    score += snags.unsent;
  }
  if (evals.allPassed) reasons.push('every eval case passes (may miss regressions)');
  return { score: Math.round(score * 10) / 10, reasons };
}

export function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

/** Overview rows, most in need of attention first. */
export function overview({ events, snags, evals, reports, skills = [], now = Date.now() }) {
  const eventsBy = bySkill(events);
  const snagsBy = bySkill(snags);
  const reportsBy = bySkill(reports);
  const names = new Set([...skills, ...eventsBy.keys(), ...snagsBy.keys(), ...evals.keys(), ...reportsBy.keys()]);
  names.delete('unknown');
  const rows = [...names].map((skill) => {
    const list = eventsBy.get(skill) ?? [];
    const all = summarize(list);
    const recent = summarize(within(list, now - 7 * DAY, now + 1));
    const previous = summarize(within(list, now - 14 * DAY, now - 7 * DAY));
    const month = summarize(within(list, now - 30 * DAY, now + 1));
    const snag = snagSummary(snagsBy.get(skill) ?? [], reportsBy.get(skill) ?? []);
    const ev = evalSummary(evals.get(skill));
    const agents = [...new Set(list.map((e) => e.agent))].sort();
    return { skill, agents, usage30d: month.invocations, daily14: dailyCounts(list, now, 14), lastUsedAt: list.filter((e) => e.kind === 'invoked').at(-1)?.time ?? null, ...pick(all), snags: snag, evals: ev, attention: attention({ snags: snag, evals: ev, recent, previous }) };
  });
  return rows.sort((a, b) => b.attention.score - a.attention.score || b.usage30d - a.usage30d || a.skill.localeCompare(b.skill));
}

function pick(summary) {
  const { errorRate, avgRetries, avgDurationMs, avgTokens, avgCacheTokens, avgCostUsd, invocations, cleanRate, toolCalls, errors } = summary;
  return { invocations, errorRate, cleanRate, avgRetries, avgDurationMs, avgTokens, avgCacheTokens, avgCostUsd, toolCalls, errors };
}

/** Invocations per day for the last `days` days, oldest first. */
function dailyCounts(list, now, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = Math.floor((now - i * DAY) / DAY) * DAY;
    out.push(within(list, start, start + DAY).filter((e) => e.kind === 'invoked').length);
  }
  return out;
}

/** Everything the skill page shows. */
export function skillDetail(skill, { events, snags, evals, reports, changes = [], now = Date.now() }) {
  const list = events.filter((e) => e.skill === skill);
  const daily = [];
  for (let i = 29; i >= 0; i -= 1) {
    const start = Math.floor((now - i * DAY) / DAY) * DAY;
    const day = within(list, start, start + DAY);
    daily.push({
      day: new Date(start).toISOString().slice(0, 10),
      invocations: day.filter((e) => e.kind === 'invoked').length,
      failedRuns: day.filter((e) => e.kind === 'completed' && e.success === false).length,
      errors: day.filter((e) => e.kind === 'error').length,
    });
  }
  const byAgent = [...bySkill(list, 'agent')].map(([agent, items]) => ({ agent, ...summarize(items) })).sort((a, b) => a.agent.localeCompare(b.agent));
  const records = evals.get(skill) ?? [];
  const skillSnags = snags.filter((s) => s.skill === skill).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const skillReports = reports.filter((r) => r.skill === skill && r.status === 'unsent');
  const warnings = [];
  if (records.at(-1)?.allPassed) warnings.push('Every case in the last eval passed. A suite that always passes may not catch meaningful changes; add harder or real-usage cases.');
  if (byAgent.length > 1) {
    const rates = byAgent.filter((a) => a.toolCalls >= 5 && a.errorRate !== null);
    const worst = rates.reduce((w, a) => (!w || a.errorRate > w.errorRate ? a : w), undefined);
    const best = rates.reduce((b, a) => (!b || a.errorRate < b.errorRate ? a : b), undefined);
    if (worst && best && worst.errorRate - best.errorRate >= 0.15) warnings.push(`Works noticeably worse in ${worst.agent} (${pct(worst.errorRate)} tool errors) than in ${best.agent} (${pct(best.errorRate)}).`);
  }
  return {
    skill,
    summary: summarize(list),
    daily,
    byAgent,
    snags: { ...snagSummary(skillSnags, skillReports), list: skillSnags },
    evals: records.map((r) => ({ ranAt: r.ranAt, score: r.score, meanDelta: r.meanDelta, ablation: Boolean(r.ablation), commit: r.commit, dirty: Boolean(r.dirty), costUsd: r.costUsd, partial: Boolean(r.partial), cases: (r.cases ?? []).length })),
    changes,
    warnings,
    // Newest first; allow-listed fields only (events never hold content).
    recent: list.slice(-40).reverse().map((e) => ({ time: e.time, agent: e.agent, kind: e.kind, success: e.success, durationMs: e.durationMs ?? null })),
  };
}

/**
 * Metrics before and after one SKILL.md change. "After" runs until the next
 * change (or now); both windows are capped at `windowDays` days.
 */
export function compare(skill, commit, { events, snags, evals, changes, now = Date.now(), windowDays = 30 }) {
  const index = changes.findIndex((c) => c.commit === commit || c.commit.startsWith(commit));
  if (index === -1) return undefined;
  const change = changes[index];
  const at = Date.parse(change.date);
  const next = index > 0 ? Date.parse(changes[index - 1].date) : now + 1;
  const prev = index < changes.length - 1 ? Date.parse(changes[index + 1].date) : -Infinity;
  const beforeFrom = Math.max(prev, at - windowDays * DAY);
  const afterTo = Math.min(next, at + windowDays * DAY);
  const list = events.filter((e) => e.skill === skill);
  const records = (evals.get(skill) ?? []).filter((r) => Date.parse(r.ranAt) <= now);
  const skillSnags = snags.filter((s) => s.skill === skill);
  const side = (from, to, evalRecord) => ({
    from: new Date(Number.isFinite(from) ? from : Math.min(...list.map((e) => Date.parse(e.time)), at)).toISOString(),
    to: new Date(Math.min(to, now)).toISOString(),
    ...summarize(within(list, from, to)),
    snagsOpened: skillSnags.filter((s) => {
      const t = Date.parse(s.createdAt);
      return t >= from && t < to;
    }).length,
    evalScore: evalRecord?.score ?? null,
    evalCommit: evalRecord?.commit ?? null,
  });
  const evalBefore = [...records].reverse().find((r) => Date.parse(r.ranAt) < at);
  const evalAfter = records.find((r) => r.commit === change.commit) ?? records.find((r) => Date.parse(r.ranAt) >= at && Date.parse(r.ranAt) < next);
  const before = side(beforeFrom, at, evalBefore);
  const after = side(at, afterTo, evalAfter);
  return { skill, change, before, after, verdict: verdict(before, after) };
}

function verdict(before, after) {
  const notes = [];
  let better = 0;
  let worse = 0;
  const errorsComparable = before.toolCalls >= 5 && after.toolCalls >= 5;
  const evalsComparable = before.evalScore !== null && after.evalScore !== null;
  if (!errorsComparable && !evalsComparable) {
    const hints = [];
    if (before.toolCalls && after.toolCalls) hints.push(`tool error rate ${pct(before.errorRate)} → ${pct(after.errorRate)}, but only ${before.toolCalls} and ${after.toolCalls} tool calls`);
    if (after.evalScore !== null && before.evalScore === null) hints.push(`eval score after the change: ${pct(after.evalScore)} (no eval before it)`);
    return { result: 'not-enough-data', notes: hints.length ? hints : ['Not enough data on both sides of this change yet.'] };
  }
  if (errorsComparable && before.errorRate !== null && after.errorRate !== null) {
    if (after.errorRate < before.errorRate - 0.03) {
      better += 1;
      notes.push(`tool error rate ${pct(before.errorRate)} → ${pct(after.errorRate)}`);
    } else if (after.errorRate > before.errorRate + 0.03) {
      worse += 1;
      notes.push(`tool error rate ${pct(before.errorRate)} → ${pct(after.errorRate)}`);
    }
  }
  if (evalsComparable) {
    if (after.evalScore > before.evalScore + 0.001) better += 1;
    if (after.evalScore < before.evalScore - 0.001) worse += 1;
    if (after.evalScore !== before.evalScore) notes.push(`eval score ${pct(before.evalScore)} → ${pct(after.evalScore)}`);
  }
  if (better && !worse) return { result: 'improved', notes };
  if (worse && !better) return { result: 'worse', notes };
  if (better && worse) return { result: 'mixed', notes };
  return { result: 'no-clear-change', notes: notes.length ? notes : ['No clear difference in error rate or eval score.'] };
}
