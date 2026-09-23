import { assert } from './schema.js';
export function advanceTime(time: { day: number; minute: number }, minutes: number, minutesPerDay: number) {
  assert(Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 10000, '时间增量无效');
  const total = time.minute + minutes;
  return { day: time.day + Math.floor(total / minutesPerDay), minute: total % minutesPerDay };
}
