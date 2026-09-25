import { randomInt } from 'node:crypto';
import { assert } from './schema.js';
import { observe } from '../observability/index.js';
export type RNG = () => number;
export const secureRng: RNG = () => randomInt(0, 2 ** 32) / 2 ** 32;
export function parseDice(expression: string) {
  const m = /^(\d{1,3})d(\d{1,6})([+-]\d{1,6})?$/i.exec(expression);
  assert(m, '骰子格式应为 NdM、NdM+K 或 NdM-K');
  const count = Number(m[1]), sides = Number(m[2]), modifier = Number(m[3] ?? 0);
  assert(count >= 1 && count <= 100 && sides >= 2 && sides <= 100000, '骰子数量或面数超出范围');
  return { count, sides, modifier };
}
export function rollDice(expression: string, rng: RNG = secureRng) {
  const { count, sides, modifier } = parseDice(expression);
  const rolls = Array.from({ length: count }, () => { const n = rng(); assert(n >= 0 && n < 1, 'RNG 必须返回 [0,1)'); return 1 + Math.floor(n * sides); });
  const total = rolls.reduce((a, b) => a + b, modifier);
  // Formal randomness is program-owned; the exact expression and result stay in the local trace.
  observe('debug', 'rng.roll', { module: 'rng', metadata: { expression, rolls, modifier, total } });
  return { expression, rolls, modifier, total };
}
