// -----------------------------------------------------------------------------
// The only place that talks to the network: POST a GraphQL document to the
// Kraken API of Octopus Energy Germany, with a timeout, a bounded body and an
// identifiable User-Agent, and the login that goes with it.
//
// The session (one per set of credentials) sends one request at a time, at
// least REQUEST_GAP apart, and holds the Kraken token in memory only (never
// in /data, never logged). It logs in with the refresh token while it is
// valid, with the credentials otherwise. A login refused for its credentials
// (KT-CT-1138, KT-CT-1134, KT-CT-1135, KT-CT-11334) is the ONLY refusal:
// every other error (a 401/403 of a query, an expired token, an unreadable
// answer, a temporary login block) is passing.
//
// Error messages carry a code and a Kraken error code at most, never the text
// of the answer (it may echo the e-mail address or an account number).
// -----------------------------------------------------------------------------

import {
  API_URL,
  MAX_BODY_BYTES,
  REQUEST_GAP,
  REQUEST_TIMEOUT,
  TOKEN_DEFAULT_LIFE,
  TOKEN_MARGIN,
  USER_AGENT,
} from '../constants.js';
import { TOKEN } from './queries.js';

export class KrakenError extends Error {
  constructor(code, { status, kt, retryAfter } = {}) {
    super(`Octopus: ${code}${kt ? ` (${kt})` : ''}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'KrakenError';
    this.code = code;
    this.status = status;
    this.kt = kt;
    this.retryAfter = retryAfter;
  }
}

/** Login errors that mean the credentials themselves are refused. */
const REFUSED = new Set(['KT-CT-1138', 'KT-CT-1134', 'KT-CT-1135']);
const API_ACCESS = 'KT-CT-11334';
/** A login Octopus blocks for a while with valid credentials (seen in October 2026). */
const LOGIN_BLOCKED = 'KT-CT-1136';
const EXPIRED = new Set(['KT-CT-1124', 'KT-CT-1120']);
const UNAUTHORIZED = new Set(['KT-CT-1111', 'KT-CT-1112', 'KT-CT-1128', 'KT-CT-1129']);
const KT = /^KT-[A-Z]{2}-\d{4,5}$/;
/** A request the GraphQL schema refuses (a field or argument that no longer exists). */
const SCHEMA_ERROR =
  /not defined|unknown (argument|field)|cannot query field|is deprecated|was removed|not a valid|expected type/i;
/** A field disabled by Kraken. */
const DISABLED = 'KT-CT-1113';

/** Retry-After (seconds or an HTTP date, against the Date header) -> ms; undefined otherwise. */
export function retryAfterMs(value, dateHeader) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  const ref = Date.parse(dateHeader ?? '');
  // Without a readable Date of the server, a date cannot be measured.
  return Number.isFinite(at) && Number.isFinite(ref) ? Math.max(0, at - ref) : undefined;
}

/** The body as text, never more than `max` bytes (cut and refused beyond). */
async function boundedText(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.().catch(() => {});
    throw new KrakenError('too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw new KrakenError('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new KrakenError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The Kraken error code of the first GraphQL error, when it has a valid one. */
export function ktOf(errors) {
  const code = errors?.[0]?.extensions?.errorCode;
  return typeof code === 'string' && KT.test(code) ? code : undefined;
}

/** A GraphQL error -> the error of the integration (not a login: see `login`). */
function graphqlError(kt) {
  if (kt === 'KT-CT-1199') return new KrakenError('rate_limited', { kt });
  if (EXPIRED.has(kt)) return new KrakenError('expired', { kt });
  if (UNAUTHORIZED.has(kt)) return new KrakenError('unauthorized', { kt });
  if (kt === 'KT-CT-7899') return new KrakenError('server', { kt });
  return new KrakenError('graphql', { kt });
}

/**
 * POST one GraphQL document; resolves `{ data, errors }` (errors only beside
 * data), throws a KrakenError otherwise.
 */
export async function post({
  fetchImpl,
  url = API_URL,
  query,
  variables,
  token,
  signal,
  timeout = REQUEST_TIMEOUT,
  maxBytes = MAX_BODY_BYTES,
}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = token;
  const timer = AbortSignal.timeout(timeout);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: both,
      redirect: 'error',
    });
    text = await boundedText(response, maxBytes);
  } catch (err) {
    if (err instanceof KrakenError) throw err;
    if (signal?.aborted) throw new KrakenError('stopped');
    throw new KrakenError(timer.aborted ? 'timeout' : 'network');
  }
  const status = response.status;
  if (status === 429) {
    throw new KrakenError('rate_limited', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        response.headers?.get?.('date'),
      ),
    });
  }
  if (status >= 500) throw new KrakenError('server', { status });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (status === 401 || status === 403) throw new KrakenError('unauthorized', { status });
    throw new KrakenError('bad_response', { status });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new KrakenError('bad_response', { status });
  }
  const errors = Array.isArray(body.errors) && body.errors.length ? body.errors : undefined;
  const data = body.data && typeof body.data === 'object' ? body.data : undefined;
  if (status === 401 || status === 403) {
    throw new KrakenError('unauthorized', { status, kt: ktOf(errors) });
  }
  if (status !== 200 && !(errors && status === 400)) {
    throw new KrakenError('http', { status });
  }
  if (!data || Object.values(data).every((v) => v === null)) {
    if (errors) {
      const kt = ktOf(errors);
      const error = graphqlError(kt);
      error.status = status;
      // A document the schema refuses (a field removed): read, never echoed.
      const message = typeof errors[0]?.message === 'string' ? errors[0].message : '';
      error.schema = !kt && SCHEMA_ERROR.test(message.slice(0, 500));
      throw error;
    }
    throw new KrakenError('bad_response', { status });
  }
  return { data, errors };
}

const TOKEN_TEXT = /^[\x21-\x7e]{16,4096}$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The lifetime of a token (ms) from its payload (the server's own clock); a default otherwise. */
export function tokenLife(payload) {
  const exp = payload?.exp;
  const iat = payload?.iat ?? payload?.origIat;
  if (finite(exp) && finite(iat) && exp > iat && exp - iat <= 24 * 3600) {
    return (exp - iat) * 1000;
  }
  return TOKEN_DEFAULT_LIFE;
}

/**
 * One session of the API for one set of credentials. `credentials`:
 * `{ email, password }` or `{ apiKey }` (never logged, never stored).
 */
export class KrakenSession {
  constructor({
    credentials,
    fetchImpl = globalThis.fetch,
    url = API_URL,
    monotonic = () => performance.now(),
    sleep,
    timeout,
    gap = REQUEST_GAP,
  }) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.monotonic = monotonic;
    this.sleep = sleep;
    this.timeout = timeout;
    this.gap = gap;
    this.token = undefined;
    this.tokenDue = 0;
    this.refreshToken = undefined;
    this.refreshDue = 0;
    this.lane = Promise.resolve();
    this.lastSent = -Infinity;
    this.abort = new AbortController();
    this.closed = false;
    /** Requests sent (tests and the status). */
    this.sent = 0;
  }

  /** Stops the session: the request in flight is aborted, nothing more is sent. */
  close() {
    this.closed = true;
    this.abort.abort();
    this.token = undefined;
    this.refreshToken = undefined;
  }

  /** One request at a time, REQUEST_GAP apart; `fn` gets the raw `send`. */
  exclusive(fn) {
    const job = this.lane.then(fn, fn);
    this.lane = job.catch(() => {});
    return job;
  }

  async send(query, variables, token) {
    if (this.closed) throw new KrakenError('stopped');
    const wait = this.lastSent + this.gap - this.monotonic();
    if (wait > 0 && this.sleep) await this.sleep(wait);
    if (this.closed) throw new KrakenError('stopped');
    this.lastSent = this.monotonic();
    this.sent += 1;
    try {
      return await post({
        fetchImpl: this.fetchImpl,
        url: this.url,
        query,
        variables,
        token,
        signal: this.abort.signal,
        ...(this.timeout ? { timeout: this.timeout } : {}),
      });
    } finally {
      // The gap counts from the end of a request: a slow answer never shortens it.
      this.lastSent = this.monotonic();
    }
  }

  /** A login: with the refresh token while valid (falling back), the credentials otherwise. */
  async login() {
    const mono = this.monotonic();
    if (this.refreshToken && mono < this.refreshDue) {
      try {
        return await this.obtain({ refreshToken: this.refreshToken }, false);
      } catch (err) {
        if (err.code === 'stopped' || err.code === 'rate_limited' || err.code === 'server') {
          throw err;
        }
        // A refresh token refused or expired: forgotten, the credentials are used.
        this.refreshToken = undefined;
      }
    }
    return this.obtain(
      this.credentials.apiKey
        ? { APIKey: this.credentials.apiKey }
        : { email: this.credentials.email, password: this.credentials.password },
      true,
    );
  }

  async obtain(input, primary) {
    const started = this.monotonic();
    let result;
    try {
      result = await this.send(TOKEN, { input });
    } catch (err) {
      if (primary && err.kt && (REFUSED.has(err.kt) || err.kt === API_ACCESS)) {
        throw new KrakenError(err.kt === API_ACCESS ? 'api_access' : 'refused', { kt: err.kt });
      }
      if (primary && err.kt === LOGIN_BLOCKED) {
        throw new KrakenError('login_blocked', { kt: err.kt });
      }
      // The login by e-mail and password, deprecated by Kraken since 2026-03-18,
      // refused by the schema or disabled: an API key is needed (never a refusal).
      if (primary && !input.APIKey && (err.kt === DISABLED || err.schema)) {
        throw new KrakenError('login_gone', { kt: err.kt });
      }
      throw err;
    }
    const out = result.data.obtainKrakenToken;
    const token = out?.token;
    if (typeof token !== 'string' || !TOKEN_TEXT.test(token)) {
      throw new KrakenError('bad_response');
    }
    let payload = out.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = undefined;
      }
    }
    const life = tokenLife(payload);
    this.token = token;
    // Counted from the moment the login was SENT: the answer may have been slow.
    this.tokenDue = started + life - Math.min(TOKEN_MARGIN, life * 0.2);
    const refresh = out.refreshToken;
    const refreshEnd = out.refreshExpiresIn;
    const iat = payload?.iat ?? payload?.origIat;
    if (typeof refresh === 'string' && TOKEN_TEXT.test(refresh)) {
      this.refreshToken = refresh;
      // Both instants are the server's: their difference needs no local clock.
      this.refreshDue =
        finite(refreshEnd) && finite(iat) && refreshEnd > iat
          ? started + Math.min(refreshEnd - iat, 30 * 24 * 3600) * 1000 - TOKEN_MARGIN
          : started + life;
    }
    return token;
  }

  /** A valid token (a login when none or close to its end). */
  async ensureToken() {
    if (!this.token || this.monotonic() >= this.tokenDue) {
      this.token = undefined;
      await this.login();
    }
    return this.token;
  }

  /** A login only (the test button): the token is kept for the next request. */
  check() {
    return this.exclusive(async () => {
      await this.ensureToken();
      return true;
    });
  }

  /**
   * One authenticated request. An expired token or a 401 of the API: one new
   * login and one new try; a second refusal stays a passing error.
   */
  request(query, variables) {
    return this.exclusive(async () => {
      const token = await this.ensureToken();
      try {
        return await this.send(query, variables, token);
      } catch (err) {
        if (err.code !== 'expired' && !(err.code === 'unauthorized' && err.status === 401)) {
          throw err;
        }
        this.token = undefined;
        const fresh = await this.ensureToken();
        return this.send(query, variables, fresh);
      }
    });
  }
}
