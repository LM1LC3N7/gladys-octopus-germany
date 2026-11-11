// -----------------------------------------------------------------------------
// What the Kraken answers mean, as pure functions: the electricity market
// locations (MaLo) of the account with their agreements and unit rates, the
// price of a quarter of an hour, the smart-meter quarters and their
// half-hours, the Intelligent devices and their planned charges.
//
// Prices are gross (VAT included), in EUR per kWh (the API gives cents). The
// price of an instant comes, in this order, from:
//   1. the agreement in force then (validFrom <= t < validTo, not revoked);
//   2. a dynamic tariff (an agreement with a unit-rate forecast): the forecast
//      slot covering t, nothing else (never a fixed rate guessed for it);
//   3. a time-of-use tariff (Intelligent Octopus Go, Heat...): the rate whose
//      activation rule covers the local time of Germany at t;
//   4. a simple tariff: its rate;
// a rate (3, 4) used only within its dated validity (grossRateInformation)
// when the API dates it. Unknown otherwise (the app then looks in the prices
// it kept in /data). Never a silent zero.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DAY,
  HALF_HOUR,
  MAX_AGREEMENTS,
  MAX_DISPATCHES,
  MAX_FLEX_DEVICES,
  MAX_FORECAST,
  MAX_METERS,
  MAX_PRICE,
  MAX_QUARTER_KWH,
  QUARTER,
} from '../constants.js';
import {
  inSlot,
  parseBound,
  parseInstant,
  parseLocalDate,
  parseTime,
  secondsOfDay,
} from '../time.js';

const MALO = /^[A-Za-z0-9]{6,40}$/;
const PROPERTY = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT = /^[A-Za-z]-[A-Za-z0-9]{4,16}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

/** A text of the API, printable and bounded; '' otherwise. */
export function clean(value, max = 60) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A strict number: a finite number, or a decimal string ("12.5"); never '' nor null. */
export function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,9}(\.\d{1,12})?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** cents per kWh -> EUR per kWh, within ± MAX_PRICE; undefined otherwise. */
export function eurPerKwh(cents) {
  const n = strictNumber(cents);
  if (n === undefined) return undefined;
  const eur = n / 100;
  return Math.abs(eur) <= MAX_PRICE ? Math.round(eur * 1e6) / 1e6 : undefined;
}

/** The stable, non-reversible key of an id (16 hex digits): never the id itself. */
export const keyOf = (kind, id) =>
  createHash('sha256').update(`octopus-germany:${kind}:${id}`, 'utf8').digest('hex').slice(0, 16);

/** The account numbers of `viewer.accounts`, valid ones only. */
export function parseAccounts(data) {
  return list(data?.viewer?.accounts, 50)
    .map((a) => (typeof a?.number === 'string' ? a.number.trim().toUpperCase() : ''))
    .filter((n) => ACCOUNT.test(n));
}

/** The dated rates of a `grossRateInformation` (object or list): [{ since, until, price }]. */
function datedRates(info) {
  const entries = Array.isArray(info) ? info : info ? [info] : [];
  const out = [];
  for (const e of entries.slice(0, 20)) {
    const since = parseLocalDate(e?.date);
    const price = eurPerKwh(e?.grossRate);
    if (since === undefined || price === undefined) continue;
    const last = parseLocalDate(e?.rateValidToDate);
    // rateValidToDate is the last day of the rate: valid until the next midnight.
    out.push({ since, until: last === undefined ? undefined : last + DAY, price });
  }
  return out;
}

/** A rate of an agreement: its dated prices and its latest price. */
function parseRate(rate) {
  return {
    dated: datedRates(rate?.grossRateInformation),
    latest: eurPerKwh(rate?.latestGrossUnitRateCentsPerKwh),
  };
}

/**
 * The price of a rate at `t`: the dated price covering t; without any dated
 * price, the latest one (the API gives no other).
 */
function rateAt(rate, t) {
  if (rate.dated.length) {
    const hit = rate.dated
      .filter((d) => d.since <= t && (d.until === undefined || t < d.until))
      .sort((a, b) => b.since - a.since)[0];
    return hit?.price;
  }
  return rate.latest;
}

function parseForecast(entries) {
  const out = [];
  for (const f of list(entries, MAX_FORECAST)) {
    const from = parseBound(f?.validFrom);
    const to = parseBound(f?.validTo);
    const info = f?.unitRateInformation;
    const cents = Array.isArray(info?.rates)
      ? info.rates[0]?.latestGrossUnitRateCentsPerKwh
      : info?.latestGrossUnitRateCentsPerKwh;
    const price = eurPerKwh(cents);
    if (
      from === undefined ||
      to === undefined ||
      price === undefined ||
      to <= from ||
      to - from > DAY ||
      from % QUARTER !== 0 ||
      to % QUARTER !== 0
    ) {
      continue;
    }
    out.push({ from, to, price });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** One agreement of a MaLo; undefined when its validity is unreadable or it is revoked. */
export function parseAgreement(a) {
  const from = parseBound(a?.validFrom);
  const to = a?.validTo === null || a?.validTo === undefined ? undefined : parseBound(a.validTo);
  if (from === undefined || (a?.validTo && to === undefined) || (to !== undefined && to <= from)) {
    return undefined;
  }
  if (a?.isRevoked === true) return undefined;
  const info = a?.unitRateInformation ?? {};
  const tou = info.__typename === 'TimeOfUseProductUnitRateInformation';
  const agreement = {
    id: clean(String(a?.id ?? ''), 40),
    from,
    to,
    code: clean(a?.product?.code, 64),
    name: clean(a?.product?.fullName, 64) || clean(a?.product?.code, 64) || 'Octopus',
    kind: tou ? 'tou' : 'simple',
    rate: tou ? undefined : parseRate(info),
    rates: [],
    forecast: parseForecast(a?.unitRateForecast),
  };
  if (tou) {
    for (const r of list(info.rates, 12)) {
      const slots = [];
      for (const rule of list(r?.timeslotActivationRules, 12)) {
        const start = parseTime(rule?.activeFromTime ?? '00:00:00');
        const end = parseTime(rule?.activeToTime ?? '00:00:00');
        if (start !== undefined && end !== undefined) slots.push({ start, end });
      }
      if (slots.length) {
        agreement.rates.push({ name: clean(r?.timeslotName, 32), slots, ...parseRate(r) });
      }
    }
  }
  return agreement;
}

/**
 * The electricity MaLos of an account answer:
 * [{ key, suffix, propertyId, malo, smart, agreements }], sorted by key.
 * `malo` (the full number) stays in memory: it filters the measurements.
 */
export function parseAccount(data) {
  const properties = data?.account?.allProperties;
  if (!Array.isArray(properties)) return undefined;
  const malos = [];
  for (const p of properties.slice(0, MAX_METERS)) {
    const propertyId = String(p?.id ?? '');
    if (!PROPERTY.test(propertyId)) continue;
    for (const m of list(p?.electricityMalos, MAX_METERS)) {
      const malo = typeof m?.maloNumber === 'string' ? m.maloNumber.trim() : '';
      if (!MALO.test(malo) || malos.some((x) => x.malo === malo)) continue;
      const meters = list(m?.meters, 4);
      malos.push({
        key: keyOf('malo', malo),
        suffix: malo.slice(-4),
        propertyId,
        malo,
        smart: meters.some(
          (x) => x?.shouldReceiveSmartMeterData === true || x?.hasSmartMeterGateway === true,
        ),
        agreements: list(m?.agreements, MAX_AGREEMENTS)
          .map(parseAgreement)
          .filter(Boolean)
          .sort((a, b) => a.from - b.from),
      });
    }
  }
  return malos.slice(0, MAX_METERS).sort((a, b) => a.key.localeCompare(b.key));
}

/** The standing charges (gross EUR per month) by agreement id: Map(id -> dated list). */
export function parseStandingCharges(data) {
  const out = new Map();
  for (const p of list(data?.account?.allProperties, MAX_METERS)) {
    for (const m of list(p?.electricityMalos, MAX_METERS)) {
      for (const a of list(m?.agreements, MAX_AGREEMENTS)) {
        const id = clean(String(a?.id ?? ''), 40);
        if (!id) continue;
        const dated = [];
        for (const e of list(a?.standingChargeGrossRateInformation, 20)) {
          const since = parseLocalDate(e?.date);
          const amount = strictNumber(e?.grossRate);
          if (since === undefined || amount === undefined || amount < 0 || amount > 1000) continue;
          const last = parseLocalDate(e?.rateValidToDate);
          dated.push({ since, until: last === undefined ? undefined : last + DAY, amount });
        }
        if (dated.length) out.set(id, dated);
      }
    }
  }
  return out;
}

/** The agreement in force at `t` (the latest started when two overlap). */
export function agreementAt(agreements, t) {
  let hit;
  for (const a of agreements ?? []) {
    if (a.from <= t && (a.to === undefined || t < a.to) && (!hit || a.from >= hit.from)) hit = a;
  }
  return hit;
}

/** The price (EUR/kWh) of the quarter starting at `t` from the agreements; undefined when unknown. */
export function priceAt(agreements, t) {
  const a = agreementAt(agreements, t);
  if (!a) return undefined;
  if (a.forecast.length) {
    return a.forecast.find((f) => f.from <= t && t < f.to)?.price;
  }
  if (a.kind === 'tou') {
    const s = secondsOfDay(t);
    const rate = a.rates.find((r) => r.slots.some((slot) => inSlot(s, slot.start, slot.end)));
    return rate ? rateAt(rate, t) : undefined;
  }
  return rateAt(a.rate, t);
}

/** The label of the price at `t`: the time slot name, else the product name. */
export function labelAt(agreements, t) {
  const a = agreementAt(agreements, t);
  if (!a) return undefined;
  if (a.kind === 'tou' && !a.forecast.length) {
    const s = secondsOfDay(t);
    const rate = a.rates.find((r) => r.slots.some((slot) => inSlot(s, slot.start, slot.end)));
    if (rate?.name) return clean(`${a.name} ${rate.name}`, 64);
  }
  return a.name;
}

/** The standing charge (EUR/month) of the agreement in force at `t`; undefined when unknown. */
export function standingChargeAt(agreements, charges, t) {
  const a = agreementAt(agreements, t);
  const dated = a ? charges?.get(a.id) : undefined;
  return dated
    ?.filter((d) => d.since <= t && (d.until === undefined || t < d.until))
    .sort((x, y) => y.since - x.since)[0]?.amount;
}

/** The end of the forecast of the agreement in force at `t` (dynamic tariffs), else undefined. */
export function forecastEnd(agreements, t) {
  const a = agreementAt(agreements, t);
  return a?.forecast.length ? a.forecast.at(-1).to : undefined;
}

const EXPORT = new Set(['EXPORT', 'FEED_IN', 'GENERATION', 'INJECTION', 'PRODUCTION']);

/**
 * The quarters of a page of measurements: `{ quarters: Map(start -> kWh),
 * conflicts: Set(start), next }`. A quarter that is not exactly 15 minutes,
 * not aligned, of another MaLo, an export, in an unknown unit, negative or
 * out of bounds is not a reading: skipped. Two different values for one
 * quarter: neither is kept.
 */
export function parseMeasurements(
  data,
  malo,
  into = { quarters: new Map(), conflicts: new Set() },
) {
  const m = data?.property?.measurements;
  if (!m || typeof m !== 'object') return undefined;
  for (const edge of list(m.edges, 200)) {
    const n = edge?.node;
    const start = parseInstant(n?.startAt);
    const end = parseInstant(n?.endAt);
    if (start === undefined || end === undefined || end - start !== QUARTER || start % QUARTER) {
      continue;
    }
    if (
      n.durationInSeconds !== undefined &&
      n.durationInSeconds !== null &&
      Number(n.durationInSeconds) !== 900
    ) {
      continue;
    }
    const filters = n.metaData?.utilityFilters;
    const f = Array.isArray(filters) ? filters[0] : filters;
    if (f?.marketSupplyPointId && f.marketSupplyPointId !== malo) continue;
    if (EXPORT.has(String(f?.readingDirection ?? '').toUpperCase())) continue;
    let kwh = strictNumber(n.value);
    const unit = String(n.unit ?? '').toLowerCase();
    if (kwh === undefined || (unit !== 'kwh' && unit !== 'wh')) continue;
    if (unit === 'wh') kwh /= 1000;
    if (kwh < 0 || kwh > MAX_QUARTER_KWH) continue;
    const known = into.quarters.get(start);
    if (known !== undefined && Math.abs(known - kwh) > 1e-9) {
      into.conflicts.add(start);
    } else {
      into.quarters.set(start, kwh);
    }
  }
  for (const c of into.conflicts) into.quarters.delete(c);
  const info = m.pageInfo ?? {};
  into.next =
    info.hasNextPage === true && typeof info.endCursor === 'string' && info.endCursor.length <= 200
      ? info.endCursor
      : undefined;
  return into;
}

/**
 * The 30-minute intervals for publishEnergyConsumption: only the half-hours
 * whose two quarters are known and that ended before `now`.
 */
export function halfHours(quarters, now) {
  const out = [];
  const starts = [...new Set([...quarters.keys()].map((t) => t - (t % HALF_HOUR)))].sort(
    (a, b) => a - b,
  );
  for (const t of starts) {
    const a = quarters.get(t);
    const b = quarters.get(t + QUARTER);
    if (a === undefined || b === undefined || t + HALF_HOUR > now) continue;
    out.push({ starts_at: new Date(t).toISOString(), kwh: Math.round((a + b) * 1e6) / 1e6 });
  }
  return out;
}

/** The Intelligent (SmartFlex) devices of the account: [{ id, key, name, type }]. */
export function parseDevices(data) {
  const devices = data?.devices;
  if (!Array.isArray(devices)) return undefined;
  const out = [];
  for (const d of devices.slice(0, MAX_FLEX_DEVICES)) {
    const id = typeof d?.id === 'string' ? d.id : String(d?.id ?? '');
    if (!DEVICE.test(id) || out.some((x) => x.id === id)) continue;
    out.push({
      id,
      key: keyOf('device', id),
      name: clean(d?.name, 40),
      type: clean(d?.deviceType, 32),
    });
  }
  return out;
}

/** The planned charges of a device: [{ start, end }], valid ones, sorted; undefined when unreadable. */
export function parseDispatches(data) {
  const list_ = data?.flexPlannedDispatches;
  if (!Array.isArray(list_)) return undefined;
  const out = [];
  for (const d of list_.slice(0, MAX_DISPATCHES)) {
    const start = parseInstant(d?.start);
    const end = parseInstant(d?.end);
    if (start === undefined || end === undefined || end <= start || end - start > DAY) continue;
    out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}
