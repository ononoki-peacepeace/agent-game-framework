/**
 * One canonical vocabulary for a character's gender. It is deliberately small and stable: a world may specify
 * it, but nothing in the framework may derive it from a name, an appearance, a role or a guess.
 *
 * `null` means "not defined yet". That is not a gender of its own: the UI shows 未设定 and the narrator must not
 * fill it in on its own. Gender never decides a character's occupation, personality, abilities or behaviour.
 */
export const genderValues = ['male', 'female', 'nonbinary'] as const;
export type Gender = (typeof genderValues)[number];
const labels: Record<Gender, string> = { male: '男', female: '女', nonbinary: '其他' };
export function isGender(value: unknown): value is Gender { return typeof value === 'string' && Object.hasOwn(labels, value); }
/** Player-facing label; anything unset or unknown stays 未设定 instead of being invented. */
export function genderLabel(value: unknown): string { return isGender(value) ? labels[value] : '未设定'; }
