// Claude Code adapter. See docs/AGENT-ADAPTERS.md.
//
// Reads only these attributes: event.name, session.id, prompt.id, skill.name,
// tool_name, success, duration_ms, model, input_tokens, output_tokens.
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
        if (REDACTED.has(skill)) skill = hints?.resolve(sessionId, time) ?? 'custom_skill';
        return tracker.open(sessionId, { skill: safeSkillName(skill), time, scope });
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
      case 'api_request': {
        const tokens = (toNumber(attrs.input_tokens) ?? 0) + (toNumber(attrs.output_tokens) ?? 0);
        return tracker.tokens(sessionId, { time, scope, tokens, model: typeof attrs.model === 'string' ? attrs.model : undefined });
      }
      case 'user_prompt':
        return tracker.close(sessionId, time);
      default:
        return [];
    }
  }

  return { agent, matches, handle, sweep: (now) => tracker.sweep(now) };
}
