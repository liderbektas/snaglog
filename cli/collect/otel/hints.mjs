// Resolve Claude Code's redacted "custom_skill" to a real skill name using the
// lines the snaglog hook wrote (see cli/connect/hooks/claude-skill-hint.mjs).
// A hint with the same hashed prompt id wins (the hook's session_id and
// prompt_id equal Claude Code's OTel session.id and prompt.id, confirmed with
// a live capture on 2.1.291); otherwise the closest hint from the same hashed
// session within WINDOW_MS is used. Each hint is used at most once.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WINDOW_MS = 60 * 1000;
const MAX_LINES = 5000;

export function createHintStore(home) {
  const file = join(home, 'hints', 'claude-code.jsonl');
  const used = new Set();

  function load() {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-MAX_LINES);
    const out = [];
    for (const line of lines) {
      try {
        const hint = JSON.parse(line);
        if (typeof hint.t === 'number' && typeof hint.s === 'string' && typeof hint.k === 'string') out.push(hint);
      } catch {
        // Skip a partially written line.
      }
    }
    return out;
  }

  return {
    resolve(sessionId, time, promptId) {
      const at = Date.parse(time);
      let best;
      for (const hint of load()) {
        const key = `${hint.t}:${hint.s}:${hint.k}`;
        if (hint.s !== sessionId || used.has(key)) continue;
        if (promptId && hint.p === promptId) {
          best = { key, distance: -1, skill: hint.k };
          break;
        }
        const distance = Math.abs(hint.t - at);
        if (distance <= WINDOW_MS && (!best || distance < best.distance)) best = { key, distance, skill: hint.k };
      }
      if (!best) return undefined;
      used.add(best.key);
      return best.skill;
    },
  };
}
