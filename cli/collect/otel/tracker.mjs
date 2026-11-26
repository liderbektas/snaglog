// Attribution windows. Agents report "a skill was invoked" but do not tag the
// tool calls that follow, so each session keeps one open window: after an
// invocation, tool results in the same session (and, where the agent provides
// it, the same prompt/turn) belong to that skill until the next prompt, another
// skill, a prompt-id change or 30 minutes of silence closes the window. The
// closing `completed` event carries the inferred duration, outcome, retries and
// tokens.

export const IDLE_MS = 30 * 60 * 1000;

export class SkillTracker {
  constructor(agent, { idleMs = IDLE_MS } = {}) {
    this.agent = agent;
    this.idleMs = idleMs;
    this.windows = new Map();
  }

  event(window, kind, time, extra = {}) {
    const event = { time, agent: this.agent, skill: window.skill, kind, sessionId: window.sessionId };
    if (window.model) event.model = window.model;
    return Object.assign(event, extra);
  }

  // `pending: true` holds back the `invoked` event while the skill name may
  // still be learned (rename); any later event or the close flushes it.
  open(sessionId, { skill, time, scope, model, pending = false }) {
    const out = this.close(sessionId, time);
    const window = { sessionId, skill, scope, model, start: time, last: time, errors: 0, calls: 0, retries: 0, tokens: 0, costUsd: 0, lastFailedTool: undefined, pending };
    this.windows.set(sessionId, window);
    out.push(...this.flush(window));
    return out;
  }

  flush(window) {
    if (!window.started) {
      if (window.pending) return [];
      window.started = true;
      return [this.event(window, 'invoked', window.start)];
    }
    return [];
  }

  /** Give a pending window its real name (same session and scope only). */
  rename(sessionId, { scope, skill }) {
    const window = this.windows.get(sessionId);
    if (!window || window.started || (scope && window.scope && scope !== window.scope)) return [];
    window.skill = skill;
    window.pending = false;
    return this.flush(window);
  }

  release(window) {
    window.pending = false;
    return this.flush(window);
  }

  current(sessionId, scope, time) {
    const window = this.windows.get(sessionId);
    if (!window) return { window: undefined, closed: [] };
    if (scope && window.scope && scope !== window.scope) return { window: undefined, closed: this.close(sessionId, time) };
    return { window, closed: [] };
  }

  toolResult(sessionId, { time, scope, success, durationMs, tool }) {
    const { window, closed } = this.current(sessionId, scope, time);
    if (!window) return closed;
    const out = this.release(window);
    window.last = time;
    window.calls += 1;
    if (tool && tool === window.lastFailedTool) window.retries += 1;
    window.lastFailedTool = success === false ? tool : undefined;
    const extra = { success: success !== false };
    if (durationMs !== undefined) extra.durationMs = durationMs;
    if (success === false) {
      window.errors += 1;
      return [...out, this.event(window, 'error', time, extra)];
    }
    return [...out, this.event(window, 'tool_call', time, extra)];
  }

  tokens(sessionId, { time, scope, tokens, costUsd, model }) {
    const { window, closed } = this.current(sessionId, scope, time);
    if (!window) return closed;
    if (tokens) window.tokens += tokens;
    if (costUsd) window.costUsd += costUsd;
    if (model && !window.model) window.model = model;
    window.last = time;
    return [];
  }

  close(sessionId, time) {
    const window = this.windows.get(sessionId);
    if (!window) return [];
    this.windows.delete(sessionId);
    const out = this.release(window);
    const end = Date.parse(window.last) || Date.parse(time);
    const extra = { success: window.errors === 0, durationMs: Math.max(0, end - Date.parse(window.start)), retries: window.retries };
    if (window.tokens) extra.tokens = window.tokens;
    if (window.costUsd) extra.costUsd = Math.round(window.costUsd * 1e6) / 1e6;
    return [...out, this.event(window, 'completed', window.last, extra)];
  }

  /** Close the window if it belongs to this scope (end of a turn). */
  closeScope(sessionId, scope, time) {
    const window = this.windows.get(sessionId);
    if (!window || (scope && window.scope && scope !== window.scope)) return [];
    window.last = time; // the turn ends here, including the final answer
    return this.close(sessionId, time);
  }

  /** Close windows that have been idle for longer than idleMs. */
  sweep(now = Date.now()) {
    const out = [];
    for (const [sessionId, window] of [...this.windows]) {
      if (now - Date.parse(window.last) > this.idleMs) out.push(...this.close(sessionId, window.last));
    }
    return out;
  }
}

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

/**
 * Skill names come from agents; anything unexpected is stored as "unknown".
 * A plugin namespace ("team-skills:count-lines", as Claude Code reports
 * skills of a repo loaded as a plugin) is dropped so telemetry joins snags
 * and evals, which use the plain name.
 */
export function safeSkillName(name) {
  if (typeof name !== 'string' || !SKILL_ID.test(name)) return 'unknown';
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) || 'unknown' : name;
}
