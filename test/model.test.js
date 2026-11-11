// -----------------------------------------------------------------------------
// The pure parts: local time of Germany (changes of time), the price of a
// quarter (simple, time-of-use, dynamic), the measurements and half-hours.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agreementAt,
  clean,
  eurPerKwh,
  halfHours,
  keyOf,
  labelAt,
  parseAccount,
  parseAccounts,
  parseAgreement,
  parseDevices,
  parseDispatches,
  parseMeasurements,
  parseStandingCharges,
  priceAt,
  standingChargeAt,
  strictNumber,
} from '../src/kraken/model.js';
import {
  addDays,
  fromBerlin,
  inSlot,
  localDate,
  parseBound,
  parseInstant,
  parseTime,
  startOfDay,
} from '../src/time.js';
import * as K from './fixtures/kraken.js';

const Q = 15 * 60_000;
const H = 3600_000;
const malosOf = (agreements) => parseAccount(K.account({ agreements }).data);

test('Berlin time: midnights and the two changes of time', () => {
  assert.equal(new Date(fromBerlin(2026, 11, 11)).toISOString(), '2026-11-10T23:00:00.000Z');
  assert.equal(new Date(fromBerlin(2026, 7, 1)).toISOString(), '2026-06-30T22:00:00.000Z');
  // Autumn: 02:30 exists twice, the first (summer time) is taken.
  assert.equal(new Date(fromBerlin(2026, 10, 25, 2, 30)).toISOString(), '2026-10-25T00:30:00.000Z');
  // Spring: 02:30 does not exist: read as winter time.
  assert.equal(new Date(fromBerlin(2026, 3, 29, 2, 30)).toISOString(), '2026-03-29T01:30:00.000Z');
  // The day of the autumn change lasts 25 hours, the spring one 23.
  assert.equal(addDays(fromBerlin(2026, 10, 25), 1) - fromBerlin(2026, 10, 25), 25 * H);
  assert.equal(addDays(fromBerlin(2026, 3, 29), 1) - fromBerlin(2026, 3, 29), 23 * H);
  assert.equal(addDays(fromBerlin(2026, 3, 30), -1), fromBerlin(2026, 3, 29));
  // 23:30 UTC is already the next day in Germany.
  assert.equal(localDate(Date.UTC(2026, 10, 11, 23, 30)), '2026-11-12');
  assert.equal(startOfDay(Date.UTC(2026, 10, 11, 23, 30)), fromBerlin(2026, 11, 12));
});

test('times, slots and instants: strict', () => {
  assert.equal(parseTime('05:00:00'), 5 * 3600);
  assert.equal(parseTime('24:00:00'), 86400);
  for (const bad of ['5:00', '25:00:00', '12:60:00', '', null, '24:30:00'])
    assert.equal(parseTime(bad), undefined);
  assert.ok(inSlot(0, 0, 5 * 3600));
  assert.ok(!inSlot(5 * 3600, 0, 5 * 3600));
  assert.ok(inSlot(23 * 3600, 5 * 3600, 0), '"00:00" as the end is the next midnight');
  assert.ok(inSlot(3600, 22 * 3600, 6 * 3600), 'across midnight');
  assert.ok(!inSlot(12 * 3600, 22 * 3600, 6 * 3600));
  assert.equal(parseInstant('2026-11-11T10:00:00+01:00'), Date.UTC(2026, 10, 11, 9));
  assert.equal(parseInstant('2026-11-11T10:00:00'), undefined, 'no offset: never a guessed zone');
  assert.equal(
    parseBound('2026-11-11T10:00:00'),
    Date.UTC(2026, 10, 11, 9),
    'a bound without offset is German',
  );
  assert.equal(parseBound('2026-11-11'), fromBerlin(2026, 11, 11));
  assert.equal(parseBound('2026-02-30'), undefined);
});

test('numbers: strict, cents to euros, bounded', () => {
  assert.equal(strictNumber(''), undefined);
  assert.equal(strictNumber(null), undefined);
  assert.equal(strictNumber('12,5'), undefined);
  assert.equal(strictNumber(' 12.5 '), 12.5);
  assert.equal(strictNumber('-3'), -3);
  assert.equal(eurPerKwh('29.5'), 0.295);
  assert.equal(eurPerKwh('-2.1'), -0.021);
  assert.equal(eurPerKwh('5000'), undefined, '50 EUR/kWh is not a price');
  assert.equal(eurPerKwh(undefined), undefined);
  assert.equal(clean('a\u0000b\n c'), 'a b c');
  assert.equal(clean('x'.repeat(100), 10).length, 10);
});

test('accounts and MaLos: the number never leaves memory, the key is stable', () => {
  assert.deepEqual(parseAccounts(K.accounts(['a-1b2c3d4e', 'bad', 'B-99999999']).data), [
    'A-1B2C3D4E',
    'B-99999999',
  ]);
  const [m] = malosOf([K.simpleAgreement()]);
  assert.equal(m.key, keyOf('malo', K.MALO));
  assert.match(m.key, /^[0-9a-f]{16}$/);
  assert.equal(m.suffix, '5678');
  assert.equal(m.propertyId, K.PROPERTY_ID);
  assert.equal(m.smart, true);
  assert.equal(parseAccount({ account: { allProperties: 'x' } }), undefined);
  assert.equal(malosOf([]).length, 1);
  const [dumb] = parseAccount(K.account({ smart: false }).data);
  assert.equal(dumb.smart, false);
});

test('agreements: unreadable, revoked or inverted ones are dropped', () => {
  assert.equal(parseAgreement({ ...K.simpleAgreement(), validFrom: 'soon' }), undefined);
  assert.equal(parseAgreement({ ...K.simpleAgreement(), isRevoked: true }), undefined);
  assert.equal(
    parseAgreement(
      K.simpleAgreement({ from: '2026-05-01T00:00:00+02:00', to: '2026-04-01T00:00:00+02:00' }),
    ),
    undefined,
  );
  const a = parseAgreement(K.simpleAgreement({ to: '2026-12-31T00:00:00+01:00' }));
  assert.equal(a.to, Date.UTC(2026, 11, 30, 23));
});

test('simple tariff: the dated rate, nothing outside the agreement', () => {
  const [m] = malosOf([K.simpleAgreement({ cents: 29.5 })]);
  assert.equal(priceAt(m.agreements, K.NOW), 0.295);
  assert.equal(priceAt(m.agreements, Date.UTC(2025, 5, 1)), undefined, 'before the agreement');
  assert.equal(labelAt(m.agreements, K.NOW), 'Octopus 12M Fix');
  // A rate dated from a later day is not used before it.
  const later = K.simpleAgreement();
  later.unitRateInformation.grossRateInformation = [
    { date: '2026-11-01', grossRate: '31', rateValidToDate: null },
  ];
  const [m2] = malosOf([later]);
  assert.equal(priceAt(m2.agreements, Date.UTC(2026, 9, 15)), undefined);
  assert.equal(priceAt(m2.agreements, K.NOW), 0.31);
  // rateValidToDate is the last day: valid until its end.
  later.unitRateInformation.grossRateInformation = [
    { date: '2026-01-01', grossRate: '28', rateValidToDate: '2026-10-31' },
    { date: '2026-11-01', grossRate: '31', rateValidToDate: null },
  ];
  const [m3] = malosOf([later]);
  assert.equal(priceAt(m3.agreements, fromBerlin(2026, 10, 31, 23, 45)), 0.28);
  assert.equal(priceAt(m3.agreements, fromBerlin(2026, 11, 1)), 0.31);
});

test('a later agreement wins from its start (tariff change mid-period)', () => {
  const [m] = malosOf([
    K.simpleAgreement({ id: '1', cents: 30, to: '2026-11-05T00:00:00+01:00' }),
    K.goAgreement({ id: '2', from: '2026-11-05T00:00:00+01:00' }),
  ]);
  assert.equal(agreementAt(m.agreements, fromBerlin(2026, 11, 4, 23, 45)).id, '1');
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 4, 3)), 0.3);
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 5, 3)), 0.19);
});

test('Intelligent Octopus Go: 00:00-05:00 local, across both changes of time', () => {
  const [m] = malosOf([K.goAgreement()]);
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 11, 3)), 0.19);
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 11, 4, 45)), 0.19);
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 11, 5)), 0.31);
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 11, 23, 45)), 0.31);
  assert.equal(labelAt(m.agreements, fromBerlin(2026, 11, 11, 3)), 'Intelligent Octopus Go GO');
  const cheap = (day) => {
    let n = 0;
    for (let t = day; t < addDays(day, 1); t += Q) if (priceAt(m.agreements, t) === 0.19) n += 1;
    return n;
  };
  assert.equal(cheap(fromBerlin(2026, 11, 11)), 20, 'a normal day: 5 hours');
  assert.equal(cheap(fromBerlin(2026, 10, 25)), 24, 'autumn: 02:00-03:00 twice, 6 real hours');
  assert.equal(cheap(fromBerlin(2026, 3, 29)), 16, 'spring: 02:00-03:00 skipped, 4 real hours');
});

test('dynamic tariff: the forecast only, never the fixed rate guessed', () => {
  const start = Date.UTC(2026, 10, 11, 9);
  const [m] = malosOf([K.dynamicAgreement({ start, hours: 3, cents: (i) => [25, -2, 40][i] })]);
  assert.equal(priceAt(m.agreements, start), 0.25);
  assert.equal(priceAt(m.agreements, start + 45 * 60_000), 0.25);
  assert.equal(priceAt(m.agreements, start + H), -0.02, 'negative price kept as a price');
  assert.equal(priceAt(m.agreements, start + 3 * H), undefined, 'after the forecast: unknown');
  assert.equal(priceAt(m.agreements, start - Q), undefined, 'before the forecast: unknown');
  // Unaligned or reversed slots are not prices.
  const bad = K.dynamicAgreement({ start: start + 60_000, hours: 2 });
  assert.equal(parseAgreement(bad).forecast.length, 0);
});

test('standing charge: the agreement in force, dated', () => {
  const [m] = malosOf([K.goAgreement()]);
  const charges = parseStandingCharges(K.standingCharges().data);
  assert.equal(standingChargeAt(m.agreements, charges, K.NOW), 12.5);
  assert.equal(standingChargeAt(m.agreements, new Map(), K.NOW), undefined);
});

test('measurements: only clean import quarters of this MaLo; conflicts dropped', () => {
  const from = Date.UTC(2026, 10, 10, 23);
  const page = K.measurements({
    from,
    to: from + 3 * H,
    kwh: () => 0.2,
    extra: (t) => {
      if (t === from + Q) return { unit: 'Wh', value: '150' };
      if (t === from + 4 * Q)
        return { metaData: { utilityFilters: { marketSupplyPointId: '50499999999' } } };
      if (t === from + 5 * Q)
        return {
          metaData: { utilityFilters: { marketSupplyPointId: K.MALO, readingDirection: 'EXPORT' } },
        };
      if (t === from + 6 * Q) return { value: '' };
      if (t === from + 7 * Q) return { value: '-1' };
      if (t === from + 8 * Q) return { unit: 'm3' };
      if (t === from + 9 * Q) return { endAt: new Date(t + 2 * Q).toISOString() };
      if (t === from + 10 * Q)
        return { startAt: '2026-11-11T02:30:00', endAt: '2026-11-11T02:45:00' };
      return {};
    },
  });
  const into = parseMeasurements(page.data, K.MALO);
  assert.equal(into.quarters.get(from), 0.2);
  assert.equal(into.quarters.get(from + Q), 0.15, 'Wh converted');
  for (const i of [4, 5, 6, 7, 8, 9, 10])
    assert.equal(into.quarters.has(from + i * Q), false, `quarter ${i}`);
  // A second page with another value for the first quarter: neither kept.
  parseMeasurements(K.measurements({ from, to: from + Q, kwh: () => 0.3 }).data, K.MALO, into);
  assert.equal(into.quarters.has(from), false);
  assert.equal(parseMeasurements({ property: null }, K.MALO), undefined);
});

test('half-hours: both quarters known and elapsed', () => {
  const t0 = Date.UTC(2026, 10, 11, 8);
  const quarters = new Map([
    [t0, 0.1],
    [t0 + Q, 0.2],
    [t0 + 2 * Q, 0.3],
    [t0 + 4 * Q, 0.1],
    [t0 + 5 * Q, 0.1],
  ]);
  assert.deepEqual(halfHours(quarters, t0 + 2 * H), [
    { starts_at: '2026-11-11T08:00:00.000Z', kwh: 0.3 },
    { starts_at: '2026-11-11T09:00:00.000Z', kwh: 0.2 },
  ]);
  assert.deepEqual(halfHours(quarters, t0 + 89 * 60_000), [
    { starts_at: '2026-11-11T08:00:00.000Z', kwh: 0.3 },
  ]);
});

test('devices and dispatches: bounded and checked', () => {
  const list = parseDevices(
    K.devices([
      { id: 'abc-123', name: 'Tesla\nModel 3', deviceType: 'ELECTRIC_VEHICLES' },
      { id: 'bad id"' },
      { id: 'abc-123' },
    ]).data,
  );
  assert.deepEqual(
    list.map((d) => [d.id, d.name]),
    [['abc-123', 'Tesla Model 3']],
  );
  assert.equal(parseDevices({ devices: null }), undefined);
  const d = parseDispatches(
    K.dispatches([
      [K.NOW, K.NOW + H],
      [K.NOW + H, K.NOW],
    ]).data,
  );
  assert.equal(d.length, 1);
  assert.equal(parseDispatches({}), undefined);
});
