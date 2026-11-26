// Claude Code adapter. See docs/AGENT-ADAPTERS.md.
//
// Reads only these attributes: event.name, session.id, prompt.id, skill.name,
// tool_name, success, duration_ms, model, input_tokens, output_tokens.
// skill.name on api_request / api_error is the real name for project and user
// skills even when skill_activated says "custom_skill" (live capture, 2.1.291).
// Everything else on the record (prompt text, tool parameters and input, error
// text, emails, account and host identifiers) is ignored and never stored.

import { safeSkillName, SkillTracker } from '../tracker.mjs';
import { toBool, toNumber } from '../otlp.mjs';

export const agent = 'claude-code';

// Names Claude Code uses when it hides a user or third-party skill's real name.
const REDACTED = new Set(['custom_skill', 'third-party']);

export function matches({ resource, attrs }) {
  const service = String(resource['service.name'] ?? '');
  return service.startsWith('claude-code') || String(attrs['event.name'] ?? '').startsWith('claude_code.');
}

export function createAdapter({ anonymize, hints }) {
  const tracker = new SkillTracker(agent);

  function handle({ attrs, time, body }) {
    const name = String(attrs['event.name'] ?? body ?? '').replace(/^claude_code\./, '');
    const rawSession = attrs['session.id'];
    if (typeof rawSession !== 'string' || !rawSession) return [];
    const sessionId = anonymize(rawSession);
    const scope = typeof attrs['prompt.id'] === 'string' ? attrs['prompt.id'] : undefined;

    switch (name) {
      case 'skill_activated': {
        let skill = attrs['skill.name'];
        if (!REDACTED.has(skill)) return tracker.open(sessionId, { skill: safeSkillName(skill), time, scope });
        skill = hints?.resolve(sessionId, time, scope ? anonymize(scope) : undefined);
        if (skill) return tracker.open(sessionId, { skill: safeSkillName(skill), time, scope });
        // No hook hint: wait for an api_request / api_error in the same prompt,
        // which carries the real name for project and user skills.
        return tracker.open(sessionId, { skill: 'custom_skill', time, scope, pending: true });
      }
      case 'tool_result':
        if (attrs.tool_name === 'Skill') return [];
        return tracker.toolResult(sessionId, {
          time,
          scope,
          success: toBool(attrs.success),
          durationMs: toNumber(attrs.duration_ms),
          tool: typeof attrs.tool_name === 'string' ? attrs.tool_name : undefined,
        });
      case 'api_error':
        return renameFrom(sessionId, scope, attrs);
      case 'api_request': {
        const renamed = renameFrom(sessionId, scope, attrs);
        const tokens = (toNumber(attrs.input_tokens) ?? 0) + (toNumber(attrs.output_tokens) ?? 0);
        return [...renamed, ...tracker.tokens(sessionId, { time, scope, tokens, model: typeof attrs.model === 'string' ? attrs.model : undefined })];
      }
      case 'user_prompt':
        return tracker.close(sessionId, time);
      default:
        return [];
    }
  }

  function renameFrom(sessionId, scope, attrs) {
    const name = attrs['skill.name'];
    if (typeof name !== 'string' || !name || REDACTED.has(name)) return [];
    return tracker.rename(sessionId, { scope, skill: safeSkillName(name) });
  }

  return { agent, matches, handle, sweep: (now) => tracker.sweep(now) };
}
