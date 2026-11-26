// Codex adapter. See docs/AGENT-ADAPTERS.md.
//
// Reads only these attributes: event.name, event.kind, conversation.id,
// skill.name, success, duration_ms, model, input_token_count,
// output_token_count. Codex also exports tool arguments, an output preview
// and the user's email by default; this adapter never reads them.

import { safeSkillName, SkillTracker } from '../tracker.mjs';
import { toBool, toNumber } from '../otlp.mjs';

export const agent = 'codex';

export function matches({ resource, attrs }) {
  return /codex/i.test(String(resource['service.name'] ?? '')) || String(attrs['event.name'] ?? '').startsWith('codex.');
}

export function createAdapter({ anonymize }) {
  const tracker = new SkillTracker(agent);

  function handle({ attrs, time }) {
    const name = String(attrs['event.name'] ?? '');
    const rawSession = attrs['conversation.id'];
    if (typeof rawSession !== 'string' || !rawSession) return [];
    const sessionId = anonymize(rawSession);
    const model = typeof attrs.model === 'string' ? attrs.model : undefined;

    switch (name) {
      case 'codex.skill_invocation':
        return tracker.open(sessionId, { skill: safeSkillName(attrs['skill.name']), time, model });
      case 'codex.tool_result':
        return tracker.toolResult(sessionId, {
          time,
          success: toBool(attrs.success),
          durationMs: toNumber(attrs.duration_ms),
          tool: typeof attrs.tool_name === 'string' ? attrs.tool_name : undefined,
        });
      case 'codex.sse_event': {
        if (attrs['event.kind'] !== 'response.completed') return [];
        const tokens = (toNumber(attrs.input_token_count) ?? 0) + (toNumber(attrs.output_token_count) ?? 0);
        return tracker.tokens(sessionId, { time, tokens, model });
      }
      case 'codex.user_prompt':
        return tracker.close(sessionId, time);
      default:
        return [];
    }
  }

  return { agent, matches, handle, sweep: (now) => tracker.sweep(now) };
}
