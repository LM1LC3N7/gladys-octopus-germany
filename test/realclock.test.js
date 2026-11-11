// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the Kraken API: the account reads really
// come at 0, the interval and twice the interval, with a bounded number of
// timers, and nothing is sent after stop(). The time is sped up 3000 times (an
// hour lasts 1.2 s) but it is the real clock: it moves between any two reads
// of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OctopusApp } from '../src/app.js';
import { ACCOUNT_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { defaults, opOf } from './helpers/app.js';
import * as K from './fixtures/kraken.js';

const SPEED = 3000;

test('real clock: account reads at 0, the interval and twice the interval; timers bounded', async (t) => {
  const reads = [];
  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests += 1;
      const { query, variables } = JSON.parse(body);
      const op = opOf(query);
      if (op === 'accounts') reads.push(performance.now() * SPEED);
      // A token for 10 hours: the renewal is another test's business.
      const answer = op === 'token' ? K.token({ life: 36000 }) : defaults[op]({ variables });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: 'octopus-germany',
    config: { email: K.EMAIL, password: K.PASSWORD },
  });
  await gladys.connect();
  const quiet = () => {};
  const app = new OctopusApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => K.NOW + (performance.now() - t0) * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    apiUrl: `http://127.0.0.1:${server.address().port}/`,
  });
  const t0 = performance.now();
  // Stopped even when an assertion fails: no timer left behind.
  t.after(() => app.stop());
  const started = performance.now() * SPEED;
  await app.connected();
  const deadline = performance.now() + 20_000;
  const until = started + 2.5 * ACCOUNT_INTERVAL;
  while (performance.now() * SPEED < until && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const sent = requests;
  await new Promise((resolve) => setTimeout(resolve, ACCOUNT_INTERVAL / SPEED));
  assert.equal(requests, sent, 'nothing sent after stop()');
  const at = reads.map((x) => Math.round((x - started) / 60_000));
  assert.equal(reads.length, 3, `reads at ${at} min`);
  assert.ok(reads[0] - started < ACCOUNT_INTERVAL / 4, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * ACCOUNT_INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * ACCOUNT_INTERVAL, `on time: ${at}`);
  }
  // Ticks every quarter (10 in 2.5 h), the reads, the gaps, /data: bounded.
  assert.ok(timersSet <= 80, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
