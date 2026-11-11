// -----------------------------------------------------------------------------
// Local time of Germany (Europe/Berlin), through the time zone database of
// Node (Intl): the changes of time are the real ones. The tariff time slots
// of Octopus ("00:00:00" to "05:00:00") are local times; the API instants
// carry their offset. Pure functions.
// -----------------------------------------------------------------------------

import { DAY, HOUR, TIME_ZONE } from './constants.js';

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The local date and time of Germany at `ms`: { y, mo, d, h, mi, s }. */
export function berlin(ms) {
  const out = {};
  for (const { type, value } of parts.formatToParts(new Date(ms))) {
    out[type] = Number(value);
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

const pad = (v) => String(v).padStart(2, '0');

/** "2026-11-11", the local date of Germany at `ms`. */
export function localDate(ms) {
  const t = berlin(ms);
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

/** Seconds since the local midnight of Germany at `ms` (a wall time, 0..86399). */
export function secondsOfDay(ms) {
  const t = berlin(ms);
  return t.h * 3600 + t.mi * 60 + t.s;
}

/** "14:05", local time of Germany. */
export function clock(ms) {
  const t = berlin(ms);
  return `${pad(t.h)}:${pad(t.mi)}`;
}

/** The instant of a local time of Germany (the first one of an hour seen twice). */
export function fromBerlin(y, mo, d, h = 0, mi = 0) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  for (const offset of [2, 1]) {
    const candidate = asUtc - offset * HOUR;
    const t = berlin(candidate);
    if (t.y === y && t.mo === mo && t.d === d && t.h === h && t.mi === mi) {
      return candidate;
    }
  }
  // A local time skipped by the spring change (02:xx): read as winter time.
  return asUtc - HOUR;
}

/** The local midnight of Germany that starts the day of `ms`. */
export function startOfDay(ms) {
  const t = berlin(ms);
  return fromBerlin(t.y, t.mo, t.d);
}

/** The local midnight `days` days before (negative) or after the day of `ms`. */
export function addDays(ms, days) {
  const t = berlin(ms);
  // Noon of the day, moved by whole days, never lands on a change of time.
  const noon = Date.UTC(t.y, t.mo - 1, t.d, 12) + days * DAY;
  const n = new Date(noon);
  return fromBerlin(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

/** "HH:MM" or "HH:MM:SS" -> seconds of the day; undefined when malformed. */
export function parseTime(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(typeof value === 'string' ? value : '');
  if (!match) return undefined;
  const [h, mi, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (h > 24 || mi > 59 || s > 59 || (h === 24 && (mi || s))) return undefined;
  return h * 3600 + mi * 60 + s;
}

/**
 * Whether a wall time (seconds of the day) is inside [from, to): "00:00" as
 * the end is the midnight of the next day; from > to crosses midnight;
 * from === to covers the whole day.
 */
export function inSlot(seconds, from, to) {
  const end = to === 0 ? 86400 : to;
  if (from === end || (from === 0 && end === 86400)) return true;
  if (from < end) return seconds >= from && seconds < end;
  return seconds >= from || seconds < end;
}

/** An ISO instant WITH its offset (or Z) -> ms; undefined otherwise (never a guessed zone). */
export function parseInstant(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A local date "YYYY-MM-DD" -> its local midnight in Germany; undefined when malformed. */
export function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return undefined;
  const [y, mo, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return fromBerlin(y, mo, d);
}

/** "YYYY-MM-DDTHH:MM[:SS]" without offset -> that local time of Germany; undefined otherwise. */
export function parseLocalDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,6})?)?$/.exec(
    typeof value === 'string' ? value : '',
  );
  if (!match || parseLocalDate(match[1]) === undefined) return undefined;
  const [y, mo, d] = match[1].split('-').map(Number);
  const [h, mi] = [Number(match[2]), Number(match[3])];
  return h > 23 || mi > 59 ? undefined : fromBerlin(y, mo, d, h, mi);
}

/**
 * A validity bound of the API: an instant with its offset; without offset (a
 * German contract), the local time of Germany; a date alone, its local midnight.
 */
export function parseBound(value) {
  return parseInstant(value) ?? parseLocalDateTime(value) ?? parseLocalDate(value);
}
