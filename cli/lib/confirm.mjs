import { createInterface } from 'node:readline/promises';

/**
 * Ask a yes/no question on the terminal. Returns true/false, or null when
 * there is no terminal to ask (callers must then refuse to act).
 */
export async function confirm(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
