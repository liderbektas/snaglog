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

  open(sessionId, { skill, time, scope, model }) {
    const out = this.close(sessionId, time);
    const window = { sessionId, skill, scope, model, start: time, last: time, errors: 0, calls: 0, retries: 0, tokens: 0, lastFailedTool: undefined };
    this.windows.set(sessionId, window);
    out.push(this.event(window, 'invoked', time));
    return out;
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
    window.last = time;
    window.calls += 1;
    if (tool && tool === window.lastFailedTool) window.retries += 1;
    window.lastFailedTool = success === false ? tool : undefined;
    const extra = { success: success !== false };
    if (durationMs !== undefined) extra.durationMs = durationMs;
    if (success === false) {
      window.errors += 1;
      return [this.event(window, 'error', time, extra)];
    }
    return [this.event(window, 'tool_call', time, extra)];
  }

  tokens(sessionId, { time, scope, tokens, model }) {
    const { window, closed } = this.current(sessionId, scope, time);
    if (!window) return closed;
    if (tokens) window.tokens += tokens;
    if (model && !window.model) window.model = model;
    window.last = time;
    return [];
  }

  close(sessionId, time) {
    const window = this.windows.get(sessionId);
    if (!window) return [];
    this.windows.delete(sessionId);
    const end = Date.parse(window.last) || Date.parse(time);
    const extra = { success: window.errors === 0, durationMs: Math.max(0, end - Date.parse(window.start)), retries: window.retries };
    if (window.tokens) extra.tokens = window.tokens;
    return [this.event(window, 'completed', window.last, extra)];
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

/** Skill names come from agents; anything unexpected is stored as "unknown". */
export function safeSkillName(name) {
  return typeof name === 'string' && SKILL_ID.test(name) ? name : 'unknown';
}
