// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Kraken API and a virtual
// clock: pace, refusal, pauses, /data, Discovery, consumption, prices,
// delegated pricing, Intelligent devices, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import { buildFlexDevice, buildMaloDevice } from '../src/devices.js';
import { fromBerlin } from '../src/time.js';
import { keyOf, parseAccount, parseAgreement, priceAt } from '../src/kraken/model.js';
import { CONFIG, DAY, HOUR, MINUTE, createKraken, json, setup, written } from './helpers/app.js';
import * as K from './fixtures/kraken.js';

const statusText = (env) => env.fake.connectionStatus?.message?.en ?? '';
const KEY = keyOf(K.ID_KEY, 'malo', K.MALO);
const F = (key, kind = 'malo', id = KEY) => `ext:octopus-germany:${kind}:${id}:${key}`;

/** The MaLo device as the user creates it from Discovery. */
const maloDevice = (env) =>
  structuredClone(env.fake.discoveredDevices.find((d) => d.external_id.includes(':malo:')));

async function started(options = {}) {
  const env = await setup(options);
  registerHandlers(env.gladys, env.app, env.app.log);
  await env.start(options.config);
  return env;
}

test('start: one login, the account read, Discovery and status; the MaLo never written out', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  assert.deepEqual(
    env.kraken.calls.map((c) => c.op),
    ['token', 'accounts', 'account', 'standing', 'devices'],
  );
  assert.equal(env.kraken.calls[2].variables.accountNumber, K.ACCOUNT_NUMBER);
  const [device] = env.fake.discoveredDevices;
  assert.equal(device.name, 'Octopus electricity (MaLo …5678)');
  assert.equal(device.external_id, `ext:octopus-germany:malo:${KEY}`);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['price', 'next_price', 'standing_charge', 'consumption'],
  );
  assert.match(statusText(env), /^Connected: 1 electricity market location/);
  assert.equal(env.fake.connectionStatus.connected, true);
  const out = written(env);
  for (const secret of [K.MALO, K.PASSWORD, K.EMAIL, 'tok-', 'ref-', K.ACCOUNT_NUMBER]) {
    assert.ok(!out.includes(secret), `${secret} written out`);
  }
  assert.equal(env.store.data.meters[0].suffix, '5678');
});

test('pace: the account every hour, never sooner; a restart waits for the rest', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.wait(59 * MINUTE);
  assert.equal(env.kraken.count('accounts'), 1);
  await env.wait(1 * MINUTE + 1000);
  assert.equal(env.kraken.count('accounts'), 2);
  // One login; the token renewed before its end with the refresh token, never the password.
  const logins = env.kraken.calls.filter((c) => c.op === 'token');
  assert.deepEqual(
    logins.map((c) => Object.keys(c.variables.input).join()),
    ['email,password', 'refreshToken'],
  );
  // Discovery, the test button, a saved config: never a read of the account.
  await env.fake.scanRequest();
  await env.fake.configUpdated(CONFIG);
  await env.wait(1000);
  assert.equal(env.kraken.count('account'), 2);
  await env.app.stop();
  // A restart 10 minutes later: the next read 50 minutes after it.
  const later = await started({ store, now: env.clock.now + 10 * MINUTE });
  t.after(() => later.app.stop());
  assert.equal(later.kraken.count('accounts'), 0);
  assert.match(statusText(later), /^Starting: first read at/);
  await later.wait(49 * MINUTE);
  assert.equal(later.kraken.count('accounts'), 0);
  await later.wait(2 * MINUTE);
  assert.equal(later.kraken.count('accounts'), 1);
});

test('a time of /data in the future is ignored; /data unreadable waits a whole interval', async (t) => {
  const future = await started({ store: createMemoryStore({ lastAccount: K.NOW + DAY }) });
  t.after(() => future.app.stop());
  assert.equal(future.kraken.count('accounts'), 1);
  const store = createMemoryStore({});
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.kraken.count('accounts'), 0);
  assert.match(statusText(env), /\/data cannot be read/);
  await env.wait(59 * MINUTE);
  assert.equal(env.kraken.count('accounts'), 0);
  assert.equal(store.saves, 0, 'never written over');
  await env.wait(2 * MINUTE);
  assert.equal(env.kraken.count('accounts'), 1);
  assert.equal(store.saves, 0, 'never written over, even after a read');
});

test('refused login: no request until the credentials change or Test succeeds; kept across a restart', async () => {
  const store = createMemoryStore();
  const kraken = createKraken({ token: () => K.ktError('KT-CT-1138') });
  const env = await started({ store, kraken });
  assert.deepEqual(
    kraken.calls.map((c) => c.op),
    ['token'],
  );
  assert.match(statusText(env), /refused the login \(KT-CT-1138\)/);
  assert.equal(env.fake.connectionStatus.connected, false);
  assert.equal(env.app.roundTimer, null, 'no read even scheduled');
  for (const secret of [K.PASSWORD, K.EMAIL, 'kunde@example.com']) {
    assert.ok(!written(env).includes(secret), 'never in logs, statuses, /data');
  }
  await env.wait(3 * DAY);
  assert.equal(kraken.calls.length, 1, 'never tried again by itself');
  const kept = JSON.stringify(store.data);
  assert.ok(!kept.includes(K.PASSWORD) && !kept.includes(K.EMAIL));
  assert.ok(store.data.refused.tag >= 0 && store.data.refused.tag < 256, '8 bits at most');
  await env.app.stop();

  // Restart: still refused, nothing sent.
  const again = await started({ store, kraken, now: env.clock.now });
  await again.wait(2 * HOUR);
  assert.equal(kraken.calls.length, 1);
  // Another password: tried at once.
  kraken.answers.token = () => K.token();
  await again.fake.configUpdated({ ...CONFIG, password: 'another one' });
  await again.wait(1000);
  assert.equal(kraken.count('token'), 2, 'tried at once');
  await again.wait(MINUTE);
  assert.equal(kraken.count('accounts'), 1);
  assert.equal(store.data.refused, null);
  await again.app.stop();
});

test('refused login lifted by a successful Test, which is limited to once a minute', async (t) => {
  const kraken = createKraken({ token: () => K.ktError('KT-CT-1138') });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  // Same credentials, still refused at Octopus: the refusal stays.
  const first = await env.fake.action('test_connection');
  assert.match(first.data.message.en, /refused the login/);
  const soon = await env.fake.action('test_connection');
  assert.match(soon.data.message.en, /less than a minute/);
  assert.equal(kraken.count('token'), 2);
  kraken.answers.token = () => K.token();
  await env.wait(MINUTE);
  const ok = await env.fake.action('test_connection');
  assert.match(ok.data.message.en, /Login accepted: 1 account/);
  // The reads resume at their pace (5 minutes after the failed attempt).
  await env.wait(4 * MINUTE);
  assert.equal(kraken.count('account'), 1, 'the reads resume');
  assert.match(statusText(env), /^Connected/);
});

test('the refused tag: a brute force over /data cannot single out the password', async () => {
  const { tagOf } = await import('../src/app.js');
  const salt = '0123456789abcdef0123456789abcdef';
  const tag = tagOf(salt, { email: K.EMAIL, password: K.PASSWORD });
  let matches = 0;
  for (let i = 0; i < 4096; i += 1)
    if (tagOf(salt, { email: K.EMAIL, password: `guess-${i}` }) === tag) matches += 1;
  assert.ok(matches > 4, `${matches} other passwords share the tag`);
});

test('KT-CT-1136 (login blocked) is a pause of an hour, never a refusal', async (t) => {
  const store = createMemoryStore();
  const kraken = createKraken({ token: () => K.ktError('KT-CT-1136') });
  const env = await started({ store, kraken });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /blocks the login for now/);
  assert.equal(store.data.refused, null);
  assert.equal(store.data.pause.code, 'login_blocked');
  await env.wait(59 * MINUTE);
  assert.equal(kraken.count('token'), 1);
  kraken.answers.token = () => K.token();
  await env.wait(2 * MINUTE);
  assert.equal(kraken.count('token'), 2);
  assert.equal(kraken.count('account'), 1);
  assert.equal(store.data.pause, null);
});

test('429: a pause of Retry-After for every request, persisted; then doubled', async (t) => {
  const store = createMemoryStore();
  const kraken = createKraken({
    accounts: () => new Response('', { status: 429, headers: { 'retry-after': '1800' } }),
  });
  const env = await started({ store, kraken });
  assert.match(statusText(env), /asked to slow down: next request at 10:37/);
  assert.equal(store.data.pause.code, 'rate_limited');
  await env.wait(MINUTE);
  const paused = await env.fake.action('test_connection');
  assert.match(paused.data.message.en, /Not sent: Octopus asked to wait until 10:37/);
  await env.wait(28 * MINUTE);
  assert.equal(kraken.count('accounts'), 1);
  assert.equal(kraken.count('token'), 1, 'the test sent nothing');
  await env.app.stop();
  // A restart during the pause keeps it; the read comes an interval after the last one.
  kraken.answers.accounts = () => K.ktError('KT-CT-1199');
  const again = await started({ store, kraken, now: env.clock.now });
  t.after(() => again.app.stop());
  assert.match(statusText(again), /asked to slow down/);
  await again.wait(30 * MINUTE);
  assert.equal(kraken.count('accounts'), 1);
  await again.wait(2 * MINUTE);
  assert.equal(kraken.count('accounts'), 2);
  // KT-CT-1199 without Retry-After, the second in a row: 15 min doubled.
  assert.equal(store.data.pause.count, 2);
  await again.wait(28 * MINUTE);
  assert.equal(kraken.count('accounts'), 2);
  kraken.answers.accounts = () => K.accounts();
  await again.wait(3 * MINUTE);
  assert.equal(kraken.count('accounts'), 3);
  assert.equal(store.data.pause, null, 'an answer ends the pause');
});

test('a 401 of the account query is never a refusal: one new login, then retried later', async (t) => {
  const kraken = createKraken({ account: () => new Response('{}', { status: 401 }) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  assert.equal(env.store.data.refused, null);
  assert.equal(kraken.count('token'), 2);
  assert.match(statusText(env), /could not be read \(unauthorized\): next try at 10:12/);
  kraken.answers.account = () => K.account();
  await env.wait(5 * MINUTE + 1000);
  assert.match(statusText(env), /^Connected/);
});

test('failures: retried after 5, 10, 20, 40 then every 60 minutes', async (t) => {
  const kraken = createKraken({ accounts: () => 'timeout' });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  const at = [];
  for (let i = 0; i < 6 * 60; i += 1) {
    const before = kraken.count('accounts');
    await env.wait(MINUTE);
    if (kraken.count('accounts') > before) at.push(i + 1);
  }
  assert.deepEqual(at, [5, 15, 35, 75, 135, 195, 255, 315]);
});

test('the standing charges or the devices failing never hide the tariff', async (t) => {
  const kraken = createKraken({
    standing: () => new Response('', { status: 500 }).status && K.ktError('KT-CT-4301'),
    devices: () => 'network',
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /^Connected/);
  await env.fake.deviceCreated(maloDevice(env));
  await env.settle();
  assert.equal(env.fake.lastState(F('price')), 0.295);
  assert.equal(env.fake.lastState(F('standing_charge')), undefined, 'unknown stays unknown');
});

test('getConfig failing in connected: retried, then started', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let fail = 1;
  env.gladys.getConfig = async () => {
    if (fail-- > 0) throw new Error('down');
    return real();
  };
  await env.app.connected();
  assert.match(statusText(env), /configuration could not be read/);
  assert.equal(env.kraken.calls.length, 0);
  await env.wait(5000);
  assert.match(statusText(env), /^Connected/);
});

test('prices: the features of a created device from what is held, at every quarter', async (t) => {
  const kraken = createKraken({ account: () => K.account({ agreements: [K.goAgreement()] }) });
  // 23:50 in Germany: the GO price starts at midnight.
  const env = await started({ kraken, now: fromBerlin(2026, 11, 4, 23, 50) });
  t.after(() => env.app.stop());
  await env.fake.deviceCreated(maloDevice(env));
  await env.settle();
  assert.equal(env.fake.lastState(F('price')), 0.31);
  assert.equal(env.fake.lastState(F('next_price')), 0.19);
  assert.equal(env.fake.lastState(F('standing_charge')), 12.5);
  const requests = kraken.calls.length;
  await env.wait(11 * MINUTE);
  assert.equal(env.fake.lastState(F('price')), 0.19);
  assert.equal(env.fake.lastState(F('next_price')), 0.31);
  const sent = kraken.calls.slice(requests).filter((c) => c.op !== 'measurements');
  assert.deepEqual(sent, [], 'the ticks send nothing (only the consumption backfill)');
});

test('prices: not published as current when the tariff was read more than 6 hours ago', async (t) => {
  const kraken = createKraken({ account: () => K.account({ agreements: [K.goAgreement()] }) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  await env.fake.deviceCreated(maloDevice(env));
  await env.settle();
  kraken.answers.accounts = () => 'network';
  const prices = () =>
    env.fake.states.filter((s) => s.device_feature_external_id === F('price')).length;
  await env.wait(5 * HOUR);
  env.gladys.forgetPublishedStates();
  let before = prices();
  await env.wait(15 * MINUTE);
  assert.equal(prices(), before + 1, 'read 5 h ago: published');
  await env.wait(2 * HOUR);
  env.gladys.forgetPublishedStates();
  before = prices();
  await env.wait(15 * MINUTE);
  assert.equal(prices(), before, 'read 7 h ago: not published');
});

test('delegated pricing: mean of the two quarters, VAT included; negative = 0; unknown = failure', async (t) => {
  const start = Date.UTC(2026, 10, 4, 9);
  const kraken = createKraken({
    account: () =>
      K.account({
        agreements: [K.dynamicAgreement({ start, hours: 3, cents: (i) => [20, -5, 40][i] })],
      }),
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  const contract = {
    id: 'c1',
    template_key: 'octopus-de-electricity',
    inputs: {},
    currency: 'EUR',
    timezone: 'Europe/Berlin',
  };
  const ack = await env.fake.energyPrice({
    contract,
    billing_period: { starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' },
    cumulative_before: { day: 0, month: 0, billing_period: 0 },
    intervals: [
      { starts_at: '2026-11-04T09:00:00.000Z', kwh: 1, max_power_kw: 2 },
      { starts_at: '2026-11-04T10:00:00.000Z', kwh: 2, max_power_kw: 2 },
      { starts_at: '2026-11-04T11:30:00.000Z', kwh: 1, max_power_kw: 2 },
    ],
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    ack.data.costs.map((c) => c.cost),
    [0.2, 0, 0.4],
  );
  const missing = await env.fake.energyPrice({
    contract,
    billing_period: { starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' },
    cumulative_before: { day: 0, month: 0, billing_period: 0 },
    intervals: [{ starts_at: '2026-11-04T12:00:00.000Z', kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(missing.success, false, 'never a silent zero');
  assert.equal(kraken.calls.filter((c) => c.at > K.NOW).length, 0, 'priced from what is held');
});

test('dynamic prices kept in /data price the past after a restart', async (t) => {
  const store = createMemoryStore();
  const start = Date.UTC(2026, 10, 4, 9);
  const kraken = createKraken({
    account: () =>
      K.account({ agreements: [K.dynamicAgreement({ start, hours: 24, cents: () => 25 })] }),
  });
  const env = await started({ store, kraken });
  await env.app.stop();
  const keys = Object.keys(store.data.prices[KEY]);
  assert.equal(keys.length, 96, 'the 24 hours known, by quarter');
  // Two days later, the forecast no longer holds these hours.
  kraken.answers.account = () =>
    K.account({ agreements: [K.dynamicAgreement({ start: start + 2 * DAY, hours: 2 })] });
  const later = await started({ store, kraken, now: K.NOW + 2 * DAY });
  t.after(() => later.app.stop());
  const ack = await later.fake.energyPrice({
    contract: { id: 'c', template_key: 'octopus-de-electricity', inputs: { malo_suffix: '5678' } },
    billing_period: {},
    cumulative_before: {},
    intervals: [{ starts_at: '2026-11-04T15:00:00.000Z', kwh: 2, max_power_kw: 1 }],
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.costs[0].cost, 0.5);
  // Another suffix: no MaLo, refused.
  const other = await later.fake.energyPrice({
    contract: { id: 'c', inputs: { malo_suffix: '9999' } },
    intervals: [{ starts_at: '2026-11-04T15:00:00.000Z', kwh: 2, max_power_kw: 1 }],
  });
  assert.equal(other.success, false);
});

test('current price: the price, its end and the next one, with their labels', async (t) => {
  const kraken = createKraken({ account: () => K.account({ agreements: [K.goAgreement()] }) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  const ack = await env.fake.energyCurrent({
    contract: { id: 'c', inputs: {} },
    cumulative: {},
    max_power_kw: 0,
  });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data, {
    price: 0.31,
    valid_until: new Date(fromBerlin(2026, 11, 5)).toISOString(),
    next_price: 0.19,
    label: 'Intelligent Octopus Go STANDARD',
    next_label: 'Intelligent Octopus Go GO',
  });
});

test('consumption: only for a created device, 7 days at first, then 3 days every 3 hours', async (t) => {
  const kraken = createKraken();
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  await env.wait(2 * HOUR);
  assert.equal(kraken.count('measurements'), 0, 'nobody created the device');
  await env.fake.deviceCreated(maloDevice(env));
  await env.wait(1000);
  const first = kraken.calls.filter((c) => c.op === 'measurements');
  assert.ok(first.length >= 7, `${first.length} pages`);
  const v = first[0].variables;
  assert.equal(v.propertyId, K.PROPERTY_ID);
  assert.equal(v.utilityFilters[0].electricityFilters.marketSupplyPointId, K.MALO);
  assert.equal(v.utilityFilters[0].electricityFilters.readingFrequencyType, 'RAW_INTERVAL');
  assert.equal(v.timezone, 'Europe/Berlin');
  assert.equal(v.startAt, new Date(fromBerlin(2026, 10, 28)).toISOString());
  const published = env.fake.publishedEnergyConsumption.filter(
    (p) => p.device_feature_external_id === F('consumption'),
  );
  assert.equal(published.length, 1);
  const intervals = published[0].intervals;
  assert.equal(intervals[0].starts_at, '2026-10-27T23:00:00.000Z');
  assert.ok(intervals.every((i) => Math.abs(i.kwh - 0.2) < 1e-9));
  assert.ok(Date.parse(intervals.at(-1).starts_at) + 30 * MINUTE <= env.clock.now, 'elapsed only');
  // The next read: 3 hours later, 3 days.
  const pages = kraken.count('measurements');
  await env.wait(3 * HOUR - 2000);
  assert.equal(kraken.count('measurements'), pages);
  await env.wait(3000);
  const next = kraken.calls.filter((c) => c.op === 'measurements').at(-1);
  assert.equal(next.variables.startAt, new Date(fromBerlin(2026, 11, 1)).toISOString());
});

test('consumption: a meter without smart-meter data has no consumption feature', async (t) => {
  const kraken = createKraken({ account: () => K.account({ smart: false }) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  const device = maloDevice(env);
  assert.ok(!device.features.some((f) => f.external_id.endsWith(':consumption')));
  await env.fake.deviceCreated(device);
  await env.wait(4 * HOUR);
  assert.equal(kraken.count('measurements'), 0);
});

test('consumption failing does not block the tariff; status says it', async (t) => {
  const kraken = createKraken({ measurements: () => K.ktError('KT-CT-4301') });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  await env.fake.deviceCreated(maloDevice(env));
  await env.wait(1000);
  assert.match(statusText(env), /consumption could not be read \(KT-CT-4301\)/);
  assert.equal(env.fake.lastState(F('price')), 0.295);
});

test('Intelligent devices: planned charges read every 15 minutes once created', async (t) => {
  const plan = [[Date.UTC(2026, 10, 4, 9, 30), Date.UTC(2026, 10, 4, 10, 30)]];
  const kraken = createKraken({
    devices: () => K.devices([{ id: 'dev-1', name: 'Wallbox', deviceType: 'CHARGE_POINTS' }]),
    dispatches: () => K.dispatches(plan),
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  const flex = env.fake.discoveredDevices.find((d) => d.external_id.includes(':flex:'));
  assert.equal(flex.name, 'Octopus Intelligent Wallbox');
  assert.ok(flex.features.every((f) => f.read_only && f.category !== 'switch'));
  assert.equal(kraken.count('dispatches'), 0);
  await env.fake.deviceCreated(structuredClone(flex));
  await env.wait(1000);
  assert.equal(kraken.count('dispatches'), 1);
  assert.match(kraken.calls.find((c) => c.op === 'dispatches').query, /deviceId: "dev-1"/);
  const id = flex.features[0].external_id;
  assert.equal(env.fake.lastState(id), 0);
  await env.wait(20 * MINUTE);
  assert.equal(kraken.count('dispatches'), 2);
  assert.equal(env.fake.lastState(id), 0);
  await env.wait(5 * MINUTE);
  assert.equal(env.fake.lastState(id), 1, 'published at the quarter');
  await env.wait(60 * MINUTE);
  assert.equal(env.fake.lastState(id), 0);
  // Planned charges read more than an hour ago: not published as current.
  kraken.answers.dispatches = () => 'network';
  await env.wait(2 * HOUR);
  env.gladys.forgetPublishedStates();
  const count = () => env.fake.states.filter((x) => x.device_feature_external_id === id).length;
  const before = count();
  await env.wait(15 * MINUTE);
  assert.equal(count(), before);
});

test('the time of a read is in /data before the request leaves', async (t) => {
  const store = createMemoryStore();
  const kraken = createKraken({
    accounts: (call) =>
      new Promise((resolve, reject) =>
        call.signal.addEventListener('abort', () =>
          reject(new DOMException('stopped', 'AbortError')),
        ),
      ),
  });
  const env = await started({ store, kraken });
  t.after(() => env.app.stop());
  assert.equal(kraken.count('accounts'), 1, 'the request is in flight');
  assert.equal(store.data.lastAccount, K.NOW);
});

test('a time of /data in the future is never taken', async (t) => {
  const env = await setup();
  t.after(() => env.app.stop());
  env.app.merge({ lastAccount: K.NOW + HOUR, lastConsumption: K.NOW + DAY });
  assert.equal(env.app.data.lastAccount, null);
  assert.equal(env.app.data.lastConsumption, null);
  env.app.merge({ lastAccount: K.NOW - HOUR });
  assert.equal(env.app.data.lastAccount, K.NOW - HOUR);
});

test('the next price unknown (end of the dynamic forecast) stays unknown', async (t) => {
  const start = Date.UTC(2026, 10, 4, 9);
  const kraken = createKraken({
    account: () =>
      K.account({ agreements: [K.dynamicAgreement({ start, hours: 2, cents: () => 25 })] }),
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  await env.fake.deviceCreated(maloDevice(env));
  await env.settle();
  assert.equal(env.fake.lastState(F('price')), 0.25);
  assert.equal(env.fake.lastState(F('next_price')), undefined);
  const current = await env.fake.energyCurrent({ contract: { id: 'c', inputs: {} } });
  assert.equal(current.data.price, 0.25);
  assert.equal(current.data.next_price, null);
});

test('several accounts: the first one, or the one entered; an unknown number is said', async (t) => {
  const kraken = createKraken({ accounts: () => K.accounts(['A-AAAA1111', K.ACCOUNT_NUMBER]) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  assert.equal(kraken.calls.find((c) => c.op === 'account').variables.accountNumber, 'A-AAAA1111');
  assert.match(statusText(env), /several accounts/);
  await env.fake.configUpdated({ ...CONFIG, account_number: 'a-1b2c3d4e' });
  await env.wait(MINUTE);
  assert.equal(
    kraken.calls.filter((c) => c.op === 'account').at(-1).variables.accountNumber,
    K.ACCOUNT_NUMBER,
  );
  await env.fake.configUpdated({ ...CONFIG, account_number: 'A-ZZZZ9999' });
  await env.wait(MINUTE);
  assert.match(statusText(env), /not one of this login/);
});

test('config problems: nothing sent', async (t) => {
  for (const [config, text] of [
    [{}, /Enter an API key/],
    [{ email: K.EMAIL }, /nothing is sent with only one/],
    [{ password: K.PASSWORD }, /nothing is sent with only one/],
    [{ email: 'nobody', password: 'x' }, /does not look like one/],
    [{ ...CONFIG, account_number: 'xyz' }, /looks like A-1B2C3D4E/],
    [{ ...CONFIG, email: `${K.EMAIL}\r\nX: y` }, /control character/],
  ]) {
    const env = await started({ config });
    t.after(() => env.app.stop());
    await env.wait(2 * HOUR);
    assert.equal(env.kraken.calls.length, 0, JSON.stringify(config));
    assert.match(statusText(env), text);
    const answer = await env.fake.action('test_connection');
    assert.match(answer.data.message.en, text);
  }
});

test('stop: nothing is sent afterwards, no timer left that sends', async () => {
  const env = await started();
  await env.app.stop();
  const n = env.kraken.calls.length;
  await env.wait(3 * DAY);
  assert.equal(env.kraken.calls.length, n);
});

test('a slow answer of an old configuration publishes nothing', async (t) => {
  let release;
  const kraken = createKraken({
    account: (call) =>
      call.at === K.NOW
        ? new Promise((r) => (release = () => r(K.account({ malo: '50400000001' }))))
        : K.account(),
  });
  const env = await setup({ kraken });
  t.after(() => env.app.stop());
  registerHandlers(env.gladys, env.app, env.app.log);
  env.app.connected();
  await env.wait(0);
  assert.ok(release);
  await env.fake.configUpdated({ ...CONFIG, password: 'changed' });
  await env.wait(1000);
  release();
  await env.wait(1000);
  assert.ok(env.fake.discoveredDevices.every((d) => d.name.endsWith('…5678)')));
});

test('the device builders: read-only, units of the core, no switch', () => {
  const gladys = {
    externalIds: (type, id) => ({
      device: `ext:x:${type}:${id}`,
      feature: (k) => `ext:x:${type}:${id}:${k}`,
    }),
  };
  const malo = buildMaloDevice(gladys, { key: KEY, suffix: '5678', smart: true, tariff: 'Go' });
  const flex = buildFlexDevice(gladys, { key: KEY, name: '', type: 'ELECTRIC_VEHICLES' });
  assert.equal(flex.name, 'Octopus Intelligent ELECTRIC_VEHICLES');
  for (const f of [...malo.features, ...flex.features]) {
    assert.equal(f.read_only, true);
    assert.notEqual(f.category, 'switch');
  }
  assert.ok(json);
});

test('two MaLos: the suffix chooses; an ambiguous one is never guessed', async (t) => {
  const malo = (number, cents) => ({
    maloNumber: number,
    meters: [{ id: number, shouldReceiveSmartMeterData: true }],
    agreements: [K.simpleAgreement({ id: number, cents })],
  });
  const kraken = createKraken({
    account: () =>
      K.account({
        malos: [malo('50412345678', 30), malo('50499995678', 40), malo('50411111234', 50)],
      }),
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  assert.equal(env.fake.discoveredDevices.length, 3);
  const price = async (suffix) =>
    env.fake.energyPrice({
      contract: { id: 'c', inputs: { malo_suffix: suffix } },
      intervals: [{ starts_at: '2026-11-04T08:00:00.000Z', kwh: 1, max_power_kw: 1 }],
    });
  assert.equal((await price('1234')).data.costs[0].cost, 0.5);
  assert.equal((await price('5678')).success, false, 'two MaLos end with 5678');
  assert.equal((await price('x y')).success, false);
  assert.equal((await price('')).success, false, 'empty with several MaLos: never a guess');
});

// --- Review r1 -----------------------------------------------------------------

test('r1 I1: an account answer with errors (KT-CT-3956) is passing; kept prices never rewritten', async (t) => {
  const store = createMemoryStore();
  const start = Date.UTC(2026, 10, 3, 23);
  const kraken = createKraken({
    account: () =>
      K.account({ agreements: [K.dynamicAgreement({ start, hours: 48, cents: () => 26 })] }),
  });
  const env = await started({ store, kraken });
  t.after(() => env.app.stop());
  const index = String(Math.floor(Date.UTC(2026, 10, 4, 1) / (15 * MINUTE)));
  assert.equal(store.data.prices[KEY][index], 0.26);
  // The forecast in error beside the data: nothing taken from this answer.
  const broken = K.account({
    agreements: [{ ...K.dynamicAgreement({ start }), unitRateForecast: null }],
  });
  kraken.answers.account = () => ({
    ...broken,
    errors: [{ message: 'Temporary error occurred.', extensions: { errorCode: 'KT-CT-3956' } }],
  });
  await env.wait(HOUR + 1000);
  assert.match(statusText(env), /last read failed \(KT-CT-3956\)/);
  assert.equal(store.data.prices[KEY][index], 0.26, 'kept price unchanged');
  const ack = await env.fake.energyPrice({
    contract: { id: 'c', inputs: {} },
    intervals: [{ starts_at: '2026-11-04T01:00:00.000Z', kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(ack.data.costs[0].cost, 0.26);
  // A forecast missing (null, no error) on an agreement seen dynamic: unknown, never the fixed 0.30.
  kraken.answers.account = () => broken;
  await env.wait(15 * MINUTE + 1000);
  await env.wait(HOUR);
  assert.equal(store.data.prices[KEY][index], 0.26);
  const later = Date.UTC(2026, 10, 6, 10);
  assert.equal(env.app.priceFor(KEY, later, env.app.malos[0]), undefined);
});

test('r1 I1: a dynamic product without readable forecast is never priced at its fixed rate', () => {
  const start = Date.UTC(2026, 10, 4, 9);
  const shifted = K.dynamicAgreement({ start: start + 60_000, hours: 3 });
  const named = { ...K.dynamicAgreement({ start }), unitRateForecast: null };
  for (const agreement of [shifted, named]) {
    const [m] = parseAccount(K.account({ agreements: [agreement] }).data, K.ID_KEY);
    assert.equal(priceAt(m.agreements, start + HOUR), undefined);
  }
});

test('r1 I2: reads without the MaLo never erase its 40 days of prices', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  t.after(() => env.app.stop());
  const kept = Object.keys(store.data.prices[KEY]).length;
  assert.ok(kept > 90);
  env.kraken.answers.account = () => K.ok({ account: { allProperties: [] } });
  await env.wait(2 * HOUR + 1000);
  assert.equal(env.kraken.count('account'), 3);
  assert.ok(Object.keys(store.data.prices[KEY]).length >= kept, 'nothing erased');
  assert.equal(store.data.meters.length, 1, 'the MaLo seen stays known');
  const ack = await env.fake.energyPrice({
    contract: { id: 'c', inputs: {} },
    intervals: [{ starts_at: '2026-11-03T12:00:00.000Z', kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.costs[0].cost, 0.295);
});

test('r1 I3: the MaLo key is an HMAC under a key kept in the Gladys config, never in /data', async (t) => {
  const { createHash } = await import('node:crypto');
  const store = createMemoryStore();
  const env = await started({ store, config: { email: K.EMAIL, password: K.PASSWORD } });
  t.after(() => env.app.stop());
  const idKey = env.fake.config.id_key;
  assert.match(idKey, /^[0-9a-f]{64}$/, 'made and stored in the Gladys config');
  const id = env.fake.discoveredDevices[0].external_id.split(':').at(-1);
  assert.equal(id, keyOf(idKey, 'malo', K.MALO));
  assert.ok(!written(env).includes(idKey), 'the id key is not in /data, logs, statuses');
  // A brute force over every MaLo ending in the 4 digits shown finds nothing without the key.
  const suffix = store.data.meters[0].suffix;
  let found = 0;
  for (let n = 0; n < 200_000; n += 1) {
    const candidate = `504${String(n).padStart(4, '0')}${suffix}`;
    const plain = createHash('sha256')
      .update(`octopus-germany:malo:${candidate}`)
      .digest('hex')
      .slice(0, 16);
    if (plain === id || keyOf('00'.repeat(32), 'malo', candidate) === id) found += 1;
  }
  assert.equal(found, 0);
  // A restart with the stored key: the same ids.
  await env.app.stop();
  const again = await started({ store, config: env.fake.config });
  t.after(() => again.app.stop());
  assert.equal(again.fake.discoveredDevices[0].external_id.split(':').at(-1), id);
});

test('r2 I1: the id key not stored: spaced tries, no storm, a status naming Gladys', async (t) => {
  const env = await setup({ config: { email: K.EMAIL, password: K.PASSWORD } });
  t.after(() => env.app.stop());
  registerHandlers(env.gladys, env.app, env.app.log);
  let fail = true;
  let calls = 0;
  const real = env.gladys.setConfig.bind(env.gladys);
  env.gladys.setConfig = async (c) => {
    calls += 1;
    if (fail) throw new Error('down');
    return real(c);
  };
  await env.start({ email: K.EMAIL, password: K.PASSWORD });
  assert.equal(env.kraken.count('account'), 0);
  assert.deepEqual(env.fake.discoveredDevices, []);
  assert.match(statusText(env), /Gladys could not store the key of the device ids/);
  await env.wait(10 * MINUTE);
  assert.ok(calls >= 2 && calls <= 8, `${calls} setConfig in 10 minutes`);
  assert.ok(env.lines.length <= 2 * calls + 4, `${env.lines.length} log lines`);
  assert.equal(env.kraken.count('account'), 0, 'nothing read without the key');
  // Ten saves of the form in a row: the key is not tried at each one.
  const before = calls;
  for (let i = 0; i < 10; i += 1)
    await env.fake.configUpdated({ email: K.EMAIL, password: K.PASSWORD });
  assert.ok(calls - before <= 1, `${calls - before} setConfig for 10 saves`);
  fail = false;
  await env.wait(20 * MINUTE);
  assert.equal(env.kraken.count('account'), 1);
  assert.equal(env.fake.discoveredDevices.length, 1);
  assert.match(statusText(env), /^Connected/);
});

test('r2 I2: a form saved during the first setConfig: one key, the stored one, the same ids after a restart', async (t) => {
  const store = createMemoryStore();
  const env = await setup({ store, config: { email: K.EMAIL, password: K.PASSWORD } });
  t.after(() => env.app.stop());
  registerHandlers(env.gladys, env.app, env.app.log);
  const real = env.gladys.setConfig.bind(env.gladys);
  let release;
  let calls = 0;
  env.gladys.setConfig = (c) => {
    calls += 1;
    return new Promise((resolve) => (release = () => resolve(real(c))));
  };
  const first = env.start({ email: K.EMAIL, password: K.PASSWORD });
  await env.settle();
  // The form is saved while the key is being stored (no id_key in what it sends).
  const saved = env.fake.configUpdated({ email: K.EMAIL, password: K.PASSWORD });
  await env.settle();
  release();
  await first;
  await saved;
  await env.wait(1000);
  assert.equal(calls, 1, 'one key made');
  assert.equal(env.app.idKey, env.fake.config.id_key, 'the key in use is the stored one');
  const id = env.fake.discoveredDevices[0].external_id;
  await env.app.stop();
  const again = await started({ store, config: env.fake.config });
  t.after(() => again.app.stop());
  assert.equal(again.fake.discoveredDevices[0].external_id, id);
});

test('r2 I2: another id key than the one /data was kept with: what depends on the old one goes', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  assert.ok(Object.keys(store.data.prices).length === 1 && store.data.keyTag);
  const other = 'cd'.repeat(32);
  const again = await started({ store, config: { ...CONFIG, id_key: other } });
  t.after(() => again.app.stop());
  const key = keyOf(other, 'malo', K.MALO);
  assert.deepEqual(again.app.data.prices, {}, 'the prices of the old keys gone');
  assert.deepEqual(again.app.data.meters, []);
  assert.deepEqual(again.fake.discoveredDevices, [], 'never a device of the old key offered');
  await again.wait(HOUR + 1000);
  assert.deepEqual(Object.keys(store.data.prices), [key]);
  assert.deepEqual(
    store.data.meters.map((m) => m.key),
    [key],
  );
  assert.equal(again.fake.discoveredDevices.length, 1, 'never the same MaLo twice');
});

test('r1 I4: the e-mail login refused by the schema: a status toward the API key, spaced tries', async (t) => {
  const store = createMemoryStore();
  const gone = () =>
    json(
      { errors: [{ message: "Field 'email' is not defined by type 'ObtainJSONWebTokenInput'." }] },
      400,
    );
  const kraken = createKraken({
    token: (call) => (call.variables.input.APIKey ? K.token() : gone()),
  });
  const env = await started({ store, kraken });
  t.after(() => env.app.stop());
  assert.match(
    statusText(env),
    /no longer accepts the login by e-mail address and password: enter an API key/,
  );
  assert.equal(store.data.refused, null, 'never a refusal');
  assert.equal(store.data.pause.code, 'login_gone');
  await env.wait(59 * MINUTE);
  assert.equal(kraken.count('token'), 1);
  await env.wait(2 * MINUTE);
  assert.equal(kraken.count('token'), 2, 'after 1 hour');
  await env.wait(117 * MINUTE);
  assert.equal(kraken.count('token'), 2);
  await env.wait(2 * MINUTE);
  assert.equal(kraken.count('token'), 3, 'then 2 hours');
  // An API key entered: tried at once, the login pause lifted.
  await env.fake.configUpdated({ ...CONFIG, api_key: 'sk_live_ABCDEFGHIJ' });
  await env.wait(MINUTE + 1000);
  assert.equal(kraken.count('account'), 1);
  assert.match(statusText(env), /^Connected/);
  // KT-CT-1113 (field disabled) is the same case.
  const disabled = createKraken({ token: () => K.ktError('KT-CT-1113') });
  const other = await started({ kraken: disabled });
  t.after(() => other.app.stop());
  assert.match(statusText(other), /no longer accepts the login/);
});

test('r1 I5: a Retry-After of years pauses 6 hours at most, also read back from /data', async (t) => {
  const { validPause } = await import('../src/app.js');
  const store = createMemoryStore();
  const kraken = createKraken({
    accounts: () => new Response('', { status: 429, headers: { 'retry-after': '1000000000' } }),
  });
  const env = await started({ store, kraken });
  t.after(() => env.app.stop());
  assert.ok(store.data.pause.until - K.NOW <= 6 * HOUR);
  const p = validPause({ until: K.NOW + 30 * DAY, count: 1, code: 'server' }, K.NOW, 1000);
  assert.equal(p.due, 1000 + 6 * HOUR);
  assert.equal(p.until, K.NOW + 6 * HOUR);
});

test('r1 I5: a 429 of the standing charges pauses; the devices query does not leave', async (t) => {
  const kraken = createKraken({ standing: () => new Response('', { status: 429 }) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  assert.equal(env.store.data.pause.code, 'rate_limited');
  assert.equal(kraken.count('devices'), 0);
});

test('r1 I5: a 429 of the consumption pauses; the next meter is not read; the 7 days not marked done', async (t) => {
  const malo = (number) => ({
    maloNumber: number,
    meters: [{ id: number, shouldReceiveSmartMeterData: true }],
    agreements: [K.simpleAgreement({ id: number })],
  });
  const kraken = createKraken({
    account: () => K.account({ malos: [malo('50412345678'), malo('50499991234')] }),
    measurements: () => new Response('', { status: 429 }),
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  for (const d of env.fake.discoveredDevices) await env.fake.deviceCreated(structuredClone(d));
  await env.wait(MINUTE + 1000);
  assert.equal(kraken.count('measurements'), 1, 'the second meter waits');
  assert.equal(env.store.data.pause.code, 'rate_limited');
  assert.equal(env.store.data.lastFull, null);
});

test('r1 I5: the daily 7 days not marked done when a meter fails', async (t) => {
  const kraken = createKraken({ measurements: () => K.ktError('KT-CT-4301') });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  await env.fake.deviceCreated(maloDevice(env));
  await env.wait(MINUTE + 1000);
  assert.ok(kraken.count('measurements') >= 1);
  assert.equal(env.store.data.lastFull, null);
});

test('r1 I5: the refused tag depends on the password', async () => {
  const { tagOf } = await import('../src/app.js');
  const salt = '0123456789abcdef0123456789abcdef';
  const tags = new Set();
  for (let i = 0; i < 32; i += 1) tags.add(tagOf(salt, { email: K.EMAIL, password: `p-${i}` }));
  assert.ok(tags.size > 8);
});

test('r1 I5: getConfig failing after stop() arms nothing; nothing is sent', async () => {
  const env = await setup();
  let reject;
  const real = env.gladys.getConfig.bind(env.gladys);
  let first = true;
  env.gladys.getConfig = () => {
    if (!first) return real();
    first = false;
    return new Promise((_, r) => (reject = r));
  };
  const pending = env.app.connected();
  await env.settle();
  await env.app.stop();
  reject(new Error('down'));
  await pending;
  await env.wait(DAY);
  assert.equal(env.kraken.calls.length, 0);
  assert.equal(env.pending.size, 0, 'no timer left');
});

test('r1 I5: an unreadable end of agreement is not an open one; overlapping, the later wins', () => {
  assert.equal(parseAgreement({ ...K.simpleAgreement(), validTo: 'soon' }), undefined);
  const [m] = parseAccount(
    K.account({
      agreements: [
        K.simpleAgreement({ id: 'old', cents: 30 }),
        K.goAgreement({ id: 'new', from: '2026-11-01T00:00:00+01:00' }),
      ],
    }).data,
    K.ID_KEY,
  );
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 11, 4, 3)), 0.19);
  assert.equal(priceAt(m.agreements, fromBerlin(2026, 10, 20, 3)), 0.3);
});

test('r1 m3: the current price of a contract is null when the tariff is stale', async (t) => {
  const kraken = createKraken({ account: () => K.account({ agreements: [K.goAgreement()] }) });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  kraken.answers.accounts = () => 'network';
  await env.wait(7 * HOUR);
  const ack = await env.fake.energyCurrent({ contract: { id: 'c', inputs: {} } });
  assert.equal(ack.data.price, null);
});

test('r1 m4: another account number alone never lifts a refusal', async (t) => {
  const kraken = createKraken({ token: () => K.ktError('KT-CT-1138') });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  await env.fake.configUpdated({ ...CONFIG, account_number: 'A-ZZZZ9999' });
  await env.wait(2 * HOUR);
  assert.equal(kraken.count('token'), 1);
  assert.match(statusText(env), /refused the login/);
});

test('r1 I1: a quarter already started keeps its kept price; a dynamic agreement stays dynamic', async (t) => {
  const store = createMemoryStore();
  const start = Date.UTC(2026, 10, 3, 23);
  // A dynamic agreement whose product name says nothing.
  const plain = (forecast) => ({
    ...K.dynamicAgreement({ start, hours: 48, cents: () => 26 }),
    product: { code: 'OE-VAR', fullName: 'Octopus Strom', isTimeOfUse: true },
    ...(forecast ? {} : { unitRateForecast: null }),
  });
  const kraken = createKraken({ account: () => K.account({ agreements: [plain(true)] }) });
  const env = await started({ store, kraken });
  t.after(() => env.app.stop());
  kraken.answers.account = () => K.account({ agreements: [plain(false)] });
  await env.wait(HOUR + 1000);
  assert.match(statusText(env), /^Connected/);
  assert.equal(
    env.app.priceFor(KEY, Date.UTC(2026, 10, 6, 12), env.app.malos[0]),
    undefined,
    'never the fixed 0.30',
  );
  // A fixed rate changed afterwards: the past quarter keeps its kept price.
  const fixed = createMemoryStore();
  const k2 = createKraken({
    account: () => K.account({ agreements: [K.simpleAgreement({ cents: 29.5 })] }),
  });
  const e2 = await started({ store: fixed, kraken: k2 });
  t.after(() => e2.app.stop());
  const index = String(Math.floor(Date.UTC(2026, 10, 3, 12) / (15 * MINUTE)));
  assert.equal(fixed.data.prices[KEY][index], 0.295);
  k2.answers.account = () => K.account({ agreements: [K.simpleAgreement({ cents: 31 })] });
  await e2.wait(HOUR + 1000);
  assert.equal(fixed.data.prices[KEY][index], 0.295);
});

test('r2 m1: Discovery published again when an Intelligent device appears after a restart', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  const kraken = createKraken({
    devices: () => K.devices([{ id: 'dev-1', name: 'Wallbox', deviceType: 'CHARGE_POINTS' }]),
  });
  const again = await started({ store, kraken, now: K.NOW + 2 * HOUR });
  t.after(() => again.app.stop());
  assert.deepEqual(
    again.fake.discoveredDevices.map((d) => d.external_id.split(':')[2]),
    ['malo', 'flex'],
  );
});

test('r2 m3: a schema error of the login that does not name the e-mail or password is not "login gone"', async (t) => {
  const kraken = createKraken({
    token: () =>
      json({ errors: [{ message: "Cannot query field 'refreshExpiresIn' on type 'X'." }] }, 400),
  });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  assert.doesNotMatch(statusText(env), /no longer accepts/);
  assert.match(statusText(env), /could not be read \(graphql\)/);
});

test('r2 m4: an error pointing at one agreement or one MaLo spoils only that part', async (t) => {
  const malo = (number, cents) => ({
    maloNumber: number,
    meters: [{ id: number, shouldReceiveSmartMeterData: true }],
    agreements: [K.simpleAgreement({ id: number, cents })],
  });
  const body = () => K.account({ malos: [malo('50412345678', 30), malo('50499991234', 40)] });
  const kraken = createKraken({ account: body });
  const env = await started({ kraken });
  t.after(() => env.app.stop());
  const [a, b] = ['50412345678', '50499991234'].map((n) => keyOf(K.ID_KEY, 'malo', n));
  const priced = (key) =>
    env.app.priceFor(
      key,
      K.NOW + 30 * DAY,
      env.app.malos.find((m) => m.key === key),
    );
  // An agreement in error: no price from it; the other MaLo is read as usual.
  const errorAt = (path) => ({
    message: 'Temporary error occurred.',
    path,
    extensions: { errorCode: 'KT-CT-3956' },
  });
  kraken.answers.account = () => ({
    ...K.account({ malos: [malo('50412345678', 33), malo('50499991234', 44)] }),
    errors: [
      errorAt([
        'account',
        'allProperties',
        0,
        'electricityMalos',
        0,
        'agreements',
        0,
        'unitRateForecast',
      ]),
    ],
  });
  await env.wait(HOUR + 1000);
  assert.match(statusText(env), /^Connected/);
  const first = env.app.malos.find((m) => m.agreements[0].broken);
  assert.ok(first);
  assert.equal(priced(first.key), undefined);
  const other = first.key === a ? b : a;
  assert.ok([0.33, 0.44].includes(priced(other)), 'the other MaLo read');
  // A MaLo in error: what was read before is kept for it.
  kraken.answers.account = () => ({
    ...K.account({ malos: [malo('50412345678', 50), malo('50499991234', 60)] }),
    errors: [errorAt(['account', 'allProperties', 0, 'electricityMalos', 1, 'meters'])],
  });
  await env.wait(HOUR + 1000);
  const prices = [a, b].map(priced).sort();
  assert.ok(prices.includes(0.5) || prices.includes(0.6), 'one MaLo read anew');
  assert.ok(
    prices.some((p) => p !== 0.5 && p !== 0.6),
    'the other kept as before',
  );
});
