import { dateAt } from '../routine/calendar.js';
import type { Calendar } from '../routine/schema.js';

/**
 * Structured age is canonical character data: whole years, or `null` meaning "not defined yet".
 *
 * Age is *derived*, never accumulated: the save stores the age the world declared plus the point it was
 * declared at, and every reader (public view, narrator, lifecycle, UI) re-derives the current value from the
 * world's own calendar. Nothing is written on a turn, so a replayed or repeated settlement cannot age anyone
 * twice, and an Undo that restores an earlier world image restores the earlier age for free.
 *
 * Two sources are supported:
 *  A. an explicit birth date in the world's calendar → the exact age, and it increases on the birthday;
 *  B. an age plus the world day it was recorded on → whole world-calendar years elapsed since that reference.
 *     This is an approximation (no birthday is known), and the reference is never treated as a birthday.
 *
 * An unknown age stays `null`: it is never guessed from a name, an appearance or a description.
 */
export const AGE_MIN = 0;
export const AGE_MAX = 100000;
export type Age = number;
export function isAge(value: unknown): value is Age {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= AGE_MIN && value <= AGE_MAX;
}
/** Player-facing label; anything unset or invalid stays 未设定 instead of being invented. */
export function ageLabel(value: unknown): string { return isAge(value) ? `${value} 岁` : '未设定'; }

export interface BirthDate { year_offset: number; month: number; day: number }
export function isBirthDate(value: unknown): value is BirthDate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.year_offset) && Number.isSafeInteger(candidate.month) && Number.isSafeInteger(candidate.day)
    && Number(candidate.month) >= 1 && Number(candidate.month) <= 12 && Number(candidate.day) >= 1;
}
/** A birth date is only usable when it exists inside this world's calendar (month lengths included). */
export function birthDateIn(calendar: Calendar | null | undefined, value: unknown): BirthDate | null {
  if (!calendar || !isBirthDate(value)) return null;
  const month = Number(value.month), day = Number(value.day);
  if (month > calendar.month_lengths.length || day > calendar.month_lengths[month - 1]) return null;
  return { year_offset: Number(value.year_offset), month, day };
}
/** The world's own year length. Never a hardcoded 365, and never the real-world calendar. */
export function worldYearLength(calendar: Calendar | null | undefined): number | null {
  const lengths = calendar?.month_lengths;
  if (!Array.isArray(lengths) || !lengths.length) return null;
  let total = 0;
  for (const length of lengths) {
    if (!Number.isSafeInteger(length) || Number(length) <= 0) return null;
    total += Number(length);
  }
  return total > 0 ? total : null;
}

export interface IdentityAgeData { age?: unknown; age_as_of_day?: unknown; birth?: unknown }
/** Everything the derivation needs: the world calendar and the current world day. */
export interface AgeSource {
  /** A SavePackage keeps the live calendar here; the world definition keeps the authored copy. */
  calendar?: Calendar | null;
  definition?: { calendar?: Calendar | null } | null;
  runtime?: { time?: { day?: number } | null } | null;
}

/** The single canonical age of a character: derived from the world clock, or the declared value as-is. */
export function identityAge(identity: IdentityAgeData | undefined, source: AgeSource | null | undefined): Age | null {
  const declared = identity?.age;
  if (!isAge(declared)) return null;
  const calendar = source?.calendar ?? source?.definition?.calendar ?? null;
  const currentDay = source?.runtime?.time?.day;
  // Without a calendar and a world clock there is nothing reliable to count from: the declared age stands.
  if (!calendar || !Number.isSafeInteger(currentDay)) return declared;
  const birth = birthDateIn(calendar, identity?.birth);
  if (birth) {
    const current = dateAt(calendar, Number(currentDay));
    const beforeBirthday = current.month < birth.month || (current.month === birth.month && current.day < birth.day);
    const years = current.yearOffset - birth.year_offset - (beforeBirthday ? 1 : 0);
    return years >= AGE_MIN && years <= AGE_MAX ? years : declared;
  }
  const reference = identity?.age_as_of_day;
  const yearLength = worldYearLength(calendar);
  if (Number.isSafeInteger(reference) && yearLength) {
    const elapsed = Math.floor((Number(currentDay) - Number(reference)) / yearLength);
    return Math.min(AGE_MAX, declared + Math.max(0, elapsed));
  }
  // No reliable reference point: the age is known but does not grow, and no birthday is invented.
  return declared;
}

/** The single canonical read of a character's age from its identity component plus the world clock. */
export function ageOf(entity: { components?: Record<string, Record<string, unknown>> } | undefined, source: AgeSource | null | undefined): Age | null {
  return identityAge(entity?.components?.identity as IdentityAgeData | undefined, source);
}

export interface LifeHorizonReference { kind: string; target_age_max: number | null }
/** The pressure an unknown age contributes: a defined fallback, so the calculation can never emit NaN. */
export const UNKNOWN_AGE_PRESSURE = 0.08;
/** Body-age contribution to closure pressure. Age is a soft signal, and an unset age is only the fallback. */
export function lifeHorizonPressure(age: unknown, horizon: LifeHorizonReference | null | undefined): number {
  if (!horizon) return UNKNOWN_AGE_PRESSURE;
  if (horizon.kind === 'open_ended' || horizon.kind === 'immortal') return 0;
  if (!isAge(age)) return UNKNOWN_AGE_PRESSURE;
  const max = horizon.target_age_max;
  if (!isAge(max) || max <= 0) return UNKNOWN_AGE_PRESSURE;
  return Math.max(0, Math.min(0.3, (age / max - 0.65) * 0.8));
}
