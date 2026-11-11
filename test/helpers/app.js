// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Kraken API (a fake fetch)
// and a virtual clock: nothing fires by itself, `wait(ms)` moves the clock and
// runs every timer due on the way, letting the promises they start settle.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OctopusApp } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import * as K from '../fixtures/kraken.js';

export const SELECTOR = 'octopus-germany';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const CONFIG = { email: K.EMAIL, password: K.PASSWORD, id_key: K.ID_KEY };

/** The operation of a GraphQL document. */
export function opOf(query = '') {
  if (query.includes('obtainKrakenToken')) return 'token';
  if (query.includes('query Accounts')) return 'accounts';
  if (query.includes('query Account(')) return 'account';
  if (query.includes('StandingCharges')) return 'standing';
  if (query.includes('FlexDevices')) return 'devices';
  if (query.includes('query Measurements')) return 'measurements';
  if (query.includes('FlexPlannedDispatches')) return 'dispatches';
  return 'unknown';
}

/** The quarters of the window, by pages of `first`, the cursor being the offset. */
export function pagedMeasurements(variables, options = {}) {
  const from = Date.parse(variables.startAt);
  const to = Date.parse(variables.endAt);
  const offset = Number(variables.after ?? 0);
  const start = from + offset * 900_000;
  const end = Math.min(to, start + variables.first * 900_000);
  const next = end < to ? String(offset + variables.first) : undefined;
  return K.measurements({ from: start, to: end, next, ...options });
}

/** The default answers, by operation. */
export const defaults = {
  token: () => K.token(),
  accounts: () => K.accounts(),
  account: () => K.account(),
  standing: () => K.standingCharges(),
  devices: () => K.devices(),
  measurements: ({ variables }) => pagedMeasurements(variables),
  dispatches: () => K.dispatches(),
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The Kraken API: `answers[op](call, now)` -> a body object | a Response |
 * 'timeout' | 'network' | a promise of one of them. `calls` records every
 * request ({ op, variables, auth, at }).
 */
export function createKraken(answers = {}) {
  const kraken = { answers: { ...defaults, ...answers }, calls: [], clock: { now: K.NOW } };
  kraken.count = (op) => kraken.calls.filter((c) => c.op === op).length;
  kraken.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = {
      op: opOf(body.query),
      query: body.query,
      variables: body.variables ?? {},
      auth: init.headers.Authorization,
      headers: init.headers,
      url,
      signal: init.signal,
      at: kraken.clock.now,
    };
    kraken.calls.push(call);
    const answer = await kraken.answers[call.op]?.(call, kraken.clock.now);
    if (answer === 'timeout') {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer instanceof Response) return answer;
    if (answer === undefined) return json({ errors: [{ message: 'no route' }] }, 400);
    return json(answer);
  };
  return kraken;
}

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  };
  async function advance(ms) {
    const target = clock.now + ms;
    await settle();
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
      await settle();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return { clock, timers, pending, advance, settle };
}

/** A device of ours as the user created it from Discovery. */
export const created = (discovered) => structuredClone(discovered);

export async function setup({
  devices: known = [],
  store = createMemoryStore(),
  now = K.NOW,
  kraken = createKraken(),
  config = CONFIG,
  wall = { offset: 0 },
  random,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  await gladys.connect();
  const { clock, timers, pending, advance, settle } = createFakeClock(now);
  kraken.clock = clock;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new OctopusApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    // A real monotonic clock moves between two reads of it: 1 µs per call.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    fetchImpl: kraken.fetch,
    requestGap: 0,
    ...(random ? { random } : {}),
  });
  const wait = (ms) => advance(ms);
  const start = async (cfg = config) => {
    gladys.fake.config = cfg;
    const done = app.connected();
    await settle();
    await done;
    await advance(0);
  };
  return {
    app,
    gladys,
    fake: gladys.fake,
    clock,
    store,
    kraken,
    start,
    wait,
    settle,
    lines,
    pending,
  };
}

/** Everything the integration ever wrote out: logs, statuses, /data, Discovery, states. */
export function written(env) {
  return JSON.stringify([
    env.lines,
    env.fake.connectionStatuses,
    env.store.data,
    env.fake.discoveredDevices,
    env.fake.states,
  ]);
}
