// -----------------------------------------------------------------------------
// The Kraken client: errors mapped without the text of the answer, bodies
// bounded, the login (refusal codes only on the login, refresh token, one new
// login on an expired token), one request at a time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { KrakenError, KrakenSession, post, retryAfterMs, tokenLife } from '../src/kraken/client.js';
import { ACCOUNTS } from '../src/kraken/queries.js';
import { USER_AGENT } from '../src/constants.js';
import { createKraken, json } from './helpers/app.js';
import * as K from './fixtures/kraken.js';

const fetchOf = (answer) => async () => (typeof answer === 'function' ? answer() : answer);
const failsWith = async (promise, code) => {
  const err = await promise.then(
    () => assert.fail('resolved'),
    (e) => e,
  );
  assert.ok(err instanceof KrakenError, String(err));
  assert.equal(err.code, code);
  assert.ok(!err.message.includes(K.EMAIL), 'never the text of the answer');
  return err;
};

test('post: headers, JSON body, no redirect followed', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return json(K.accounts());
  };
  const { data } = await post({ fetchImpl, query: ACCOUNTS, token: 'tok-AAAAAAAAAAAAAAAA' });
  assert.equal(data.viewer.accounts[0].number, K.ACCOUNT_NUMBER);
  assert.equal(seen.url, 'https://api.oeg-kraken.energy/v1/graphql/');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers['User-Agent'], USER_AGENT);
  assert.match(
    USER_AGENT,
    /^gladys-octopus-germany\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-octopus-germany\)$/,
  );
  assert.equal(seen.init.headers.Authorization, 'tok-AAAAAAAAAAAAAAAA');
  assert.equal(seen.init.headers.Accept, 'application/json');
});

test('post: every failure is a coded error, never the text of the answer', async () => {
  const p = (answer) => post({ fetchImpl: fetchOf(answer), query: ACCOUNTS });
  await failsWith(p(json(K.ktError('KT-CT-1199'))), 'rate_limited');
  await failsWith(p(json(K.ktError('KT-CT-1124'))), 'expired');
  await failsWith(p(json(K.ktError('KT-CT-1111'))), 'unauthorized');
  await failsWith(p(json(K.ktError('KT-CT-7899'))), 'server');
  const other = await failsWith(p(json(K.ktError('KT-CT-4301'))), 'graphql');
  assert.equal(other.kt, 'KT-CT-4301');
  await failsWith(p(json(K.ktError('not a code; kunde@example.com'))), 'graphql');
  await failsWith(
    p(new Response('<html>kunde@example.com</html>', { status: 200 })),
    'bad_response',
  );
  await failsWith(p(new Response('[]', { status: 200 })), 'bad_response');
  await failsWith(p(json({ data: null })), 'bad_response');
  await failsWith(p(new Response('busy', { status: 503 })), 'server');
  await failsWith(p(new Response('no', { status: 401 })), 'unauthorized');
  await failsWith(p(new Response('moved', { status: 302 })), 'bad_response');
  await failsWith(p(json({}, 404)), 'http');
  const limited = await failsWith(
    p(new Response('', { status: 429, headers: { 'retry-after': '120' } })),
    'rate_limited',
  );
  assert.equal(limited.retryAfter, 120_000);
  // Partial data with errors (a field refused): the data is used.
  const { data, errors } = await post({
    fetchImpl: fetchOf(
      json({ data: { viewer: { accounts: [] }, other: null }, errors: [{ message: 'x' }] }),
    ),
    query: ACCOUNTS,
  });
  assert.deepEqual(data.viewer.accounts, []);
  assert.equal(errors.length, 1);
});

test('post: network failures and timeouts', async (t) => {
  await failsWith(
    post({ fetchImpl: async () => Promise.reject(new TypeError('fetch failed')), query: ACCOUNTS }),
    'network',
  );
  // AbortSignal.timeout() does not keep the event loop alive (a real socket
  // does): a timer holds it during the test.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const hang = (url, init) =>
    new Promise((resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(init.signal.reason)),
    );
  await failsWith(post({ fetchImpl: hang, query: ACCOUNTS, timeout: 30 }), 'timeout');
  const stop = new AbortController();
  const pending = post({ fetchImpl: hang, query: ACCOUNTS, signal: stop.signal });
  stop.abort();
  await failsWith(pending, 'stopped');
});

test('post: an oversized body is cut before it is read whole (real server)', async (t) => {
  let written = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => {
      while (written < 50 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => server.closeAllConnections());
  const url = `http://127.0.0.1:${server.address().port}/`;
  await failsWith(
    post({ fetchImpl: fetch, url, query: ACCOUNTS, maxBytes: 256 * 1024 }),
    'too_large',
  );
  assert.ok(written < 20 * 1024 * 1024, `${written} bytes sent before the cut`);
  // A declared Content-Length beyond the bound: refused before reading.
  const declared = new Response('x', { headers: { 'content-length': String(10 ** 9) } });
  await failsWith(post({ fetchImpl: fetchOf(declared), query: ACCOUNTS }), 'too_large');
});

test('Retry-After and token lifetime: from the server clock only', () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 10:00:00 GMT'), undefined, 'no Date header: unknown');
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 10:00:00 GMT', 'Wed, 11 Nov 2026 09:58:00 GMT'),
    120_000,
  );
  assert.equal(retryAfterMs(''), undefined);
  assert.equal(tokenLife({ exp: 1000 + 3600, iat: 1000 }), 3600_000);
  assert.equal(tokenLife({ exp: 1000 }), 50 * 60_000, 'no iat: the default, never "expired"');
  assert.equal(tokenLife(undefined), 50 * 60_000);
});

const session = (kraken, extra = {}) => {
  const clock = { now: 0 };
  const s = new KrakenSession({
    credentials: { email: K.EMAIL, password: K.PASSWORD },
    fetchImpl: kraken.fetch,
    monotonic: () => clock.now,
    gap: 0,
    ...extra,
  });
  return { s, clock };
};

test('session: one login for many requests, the refresh token near the end', async () => {
  const kraken = createKraken();
  const { s, clock } = session(kraken);
  await s.request(ACCOUNTS);
  await s.request(ACCOUNTS);
  assert.deepEqual(
    kraken.calls.map((c) => c.op),
    ['token', 'accounts', 'accounts'],
  );
  const login = kraken.calls[0];
  assert.equal(login.auth, undefined, 'the login carries no token');
  assert.deepEqual(login.variables.input, { email: K.EMAIL, password: K.PASSWORD });
  assert.match(kraken.calls[1].auth, /^tok-/);
  // 56 minutes later (renewed 5 min before the end of a 60-min token).
  clock.now = 56 * 60_000;
  await s.request(ACCOUNTS);
  const renew = kraken.calls[3];
  assert.equal(renew.op, 'token');
  assert.deepEqual(
    Object.keys(renew.variables.input),
    ['refreshToken'],
    'never the password again',
  );
  // The refresh token refused: the credentials are used.
  kraken.answers.token = (call) =>
    call.variables.input.refreshToken ? K.ktError('KT-CT-1135') : K.token();
  clock.now = 120 * 60_000;
  await s.request(ACCOUNTS);
  const ops = kraken.calls.slice(5).map((c) => [c.op, Object.keys(c.variables.input ?? {}).join()]);
  assert.deepEqual(ops, [
    ['token', 'refreshToken'],
    ['token', 'email,password'],
    ['accounts', ''],
  ]);
});

test('session: the refusal codes of the login only; 1136 and others are not refusals', async () => {
  for (const kt of ['KT-CT-1138', 'KT-CT-1134', 'KT-CT-1135']) {
    const kraken = createKraken({ token: () => K.ktError(kt) });
    const err = await failsWith(session(kraken).s.request(ACCOUNTS), 'refused');
    assert.equal(err.kt, kt);
    assert.equal(kraken.count('accounts'), 0);
  }
  await failsWith(
    session(createKraken({ token: () => K.ktError('KT-CT-11334') })).s.request(ACCOUNTS),
    'api_access',
  );
  await failsWith(
    session(createKraken({ token: () => K.ktError('KT-CT-1136') })).s.request(ACCOUNTS),
    'login_blocked',
  );
  await failsWith(
    session(createKraken({ token: () => K.ktError('KT-CT-1199') })).s.request(ACCOUNTS),
    'rate_limited',
  );
  await failsWith(
    session(createKraken({ token: () => new Response('x', { status: 403 }) })).s.request(ACCOUNTS),
    'unauthorized',
  );
  await failsWith(
    session(
      createKraken({ token: () => K.ok({ obtainKrakenToken: { token: 'short' } }) }),
    ).s.request(ACCOUNTS),
    'bad_response',
  );
  await failsWith(
    session(
      createKraken({
        token: () => K.ok({ obtainKrakenToken: { token: 'bad\r\ntoken-AAAAAAAAAAAA' } }),
      }),
    ).s.request(ACCOUNTS),
    'bad_response',
  );
  // A query refused (401, KT-CT-1111): never a refusal of the credentials.
  const kraken = createKraken({ accounts: () => new Response('{}', { status: 401 }) });
  await failsWith(session(kraken).s.request(ACCOUNTS), 'unauthorized');
  assert.equal(kraken.count('token'), 2, 'one new login, one new try, then given up');
  assert.equal(kraken.count('accounts'), 2);
  await failsWith(
    session(createKraken({ accounts: () => K.ktError('KT-CT-1111') })).s.request(ACCOUNTS),
    'unauthorized',
  );
});

test('session: an expired token gets one new login and one new try', async () => {
  let first = true;
  const kraken = createKraken({
    accounts: () => {
      if (first) {
        first = false;
        return K.ktError('KT-CT-1124');
      }
      return K.accounts();
    },
  });
  const { data } = await session(kraken).s.request(ACCOUNTS);
  assert.equal(data.viewer.accounts.length, 1);
  assert.deepEqual(
    kraken.calls.map((c) => c.op),
    ['token', 'accounts', 'token', 'accounts'],
  );
});

test('session: the API key alone when given', async () => {
  const kraken = createKraken();
  const s = new KrakenSession({
    credentials: { apiKey: 'sk_live_ABCDEFGH' },
    fetchImpl: kraken.fetch,
    gap: 0,
  });
  await s.request(ACCOUNTS);
  assert.deepEqual(kraken.calls[0].variables.input, { APIKey: 'sk_live_ABCDEFGH' });
});

test('session: one request at a time, the gap after the end of the previous one', async () => {
  let inFlight = 0;
  let peak = 0;
  const kraken = createKraken({
    accounts: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return K.accounts();
    },
  });
  const slept = [];
  const clock = { now: 0 };
  const s = new KrakenSession({
    credentials: { email: K.EMAIL, password: K.PASSWORD },
    fetchImpl: kraken.fetch,
    monotonic: () => clock.now,
    sleep: async (ms) => {
      slept.push(ms);
      clock.now += ms;
    },
    gap: 2000,
  });
  await Promise.all([s.request(ACCOUNTS), s.request(ACCOUNTS), s.request(ACCOUNTS)]);
  assert.equal(peak, 1);
  assert.deepEqual(slept, [2000, 2000, 2000], 'login, then 3 requests, each 2 s apart');
  s.close();
  await failsWith(s.request(ACCOUNTS), 'stopped');
});
