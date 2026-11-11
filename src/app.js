// -----------------------------------------------------------------------------
// The integration itself: the Octopus Energy Germany account read through the
// Kraken GraphQL API, one Gladys device per electricity market location
// (MaLo) and per Intelligent device, the smart-meter consumption published
// after the fact (publishEnergyConsumption), the prices kept to price the
// delegated contracts, the pauses and the refused login kept in /data, the
// test button. index.js only wires the SDK handlers to it. Read-only: the
// only mutation ever sent is the login.
//
// Pace (each kept in /data before the request, so a restart never reads
// sooner): the account (tariffs, dynamic prices ahead, devices) every hour;
// the consumption of the CREATED meter devices every 3 hours (3 days; 7 days
// once a day after 06:00 in Germany and for a new device); the planned charges
// of the CREATED Intelligent devices every 15 minutes. A failed read is tried
// again after 5, 10, 20, 40 then every 60 minutes; a 429, a 5xx or a blocked
// login pause every request (persisted, at most 6 hours). The price features
// are published again at every quarter of an hour from what is held: no
// request.
//
// Two clocks: `now` (wall clock) dates the prices, the consumption and what
// /data keeps; `monotonic` paces the reads, the pauses and the token, so that
// a wall clock set back or forward never stops nor hurries them.
//
// A start (config saved, reconnection) opens a new generation: a late answer
// of an older one publishes nothing and sets no status (checked after every
// await).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { credentialsOf, normalizeConfig } from './config.js';
import {
  ACCOUNT_INTERVAL,
  BACKFILL_DAYS,
  BACKFILL_HOUR,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CONSUMPTION_DAYS,
  CONSUMPTION_INTERVAL,
  CREATED_MIN_GAP,
  DAY,
  DISPATCH_INTERVAL,
  HOUR,
  LOGIN_BLOCK_PAUSE,
  MAX_ACCOUNTS,
  MAX_PAGES,
  MAX_STATUS,
  PAGE_SIZE,
  PAUSE_MAX,
  PRICE_HISTORY_DAYS,
  PRICES_MAX_AGE,
  QUARTER,
  RATE_LIMIT_PAUSE,
  RETRY_MAX,
  RETRY_MIN,
  SERVER_PAUSE,
  STORE_RETRY,
  STORE_WAIT,
  TEST_MIN_GAP,
  TICK,
  TIME_ZONE,
} from './constants.js';
import {
  FEATURE,
  KIND,
  buildFlexDevice,
  buildMaloDevice,
  idsOf,
  parseDeviceId,
  priceStates,
} from './devices.js';
import { both, t } from './i18n.js';
import { KrakenError, KrakenSession } from './kraken/client.js';
import {
  forecastEnd,
  halfHours,
  labelAt,
  parseAccount,
  parseAccounts,
  parseDevices,
  parseDispatches,
  parseMeasurements,
  parseStandingCharges,
  priceAt,
  standingChargeAt,
} from './kraken/model.js';
import {
  ACCOUNT,
  ACCOUNTS,
  DEVICES,
  MEASUREMENTS,
  STANDING_CHARGES,
  dispatchesOf,
} from './kraken/queries.js';
import { FileStore } from './store.js';
import { addDays, berlin, clock, localDate } from './time.js';

const TIMED_OUT = Symbol('timed out');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const KEY = /^[0-9a-f]{16}$/;
/** Errors that pause every request. */
const PAUSING = new Set(['rate_limited', 'server', 'login_blocked']);

/** 8 bits of a salted hash of the credentials: nothing to find them back from. */
export const tagOf = (salt, credentials) =>
  createHash('sha256')
    .update(
      `${salt}\u0000${credentials.apiKey ?? ''}\u0000${credentials.email ?? ''}\u0000${credentials.password ?? ''}`,
      'utf8',
    )
    .digest()[0];

/** A pause read back from /data, its rest capped to PAUSE_MAX; undefined when invalid. */
export function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSING.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 16),
    code: pause.code,
    detail: typeof pause.detail === 'string' ? pause.detail.slice(0, 24) : null,
  };
}

export function validRefused(refused) {
  return refused &&
    typeof refused.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(refused.salt) &&
    Number.isInteger(refused.tag) &&
    refused.tag >= 0 &&
    refused.tag < 256
    ? {
        salt: refused.salt,
        tag: refused.tag,
        code: refused.code === 'api_access' ? 'api_access' : 'refused',
        kt:
          typeof refused.kt === 'string' && /^KT-CT-\d{4,5}$/.test(refused.kt) ? refused.kt : null,
      }
    : undefined;
}

function validMeters(meters) {
  const out = [];
  for (const m of Array.isArray(meters) ? meters.slice(0, 8) : []) {
    if (
      !KEY.test(m?.key ?? '') ||
      typeof m.suffix !== 'string' ||
      !/^[A-Za-z0-9]{1,4}$/.test(m.suffix)
    )
      continue;
    out.push({
      key: m.key,
      suffix: m.suffix,
      smart: m.smart === true,
      tariff: typeof m.tariff === 'string' ? m.tariff.slice(0, 64) : '',
    });
  }
  return out;
}

/** The prices kept: { maloKey: { quarterIndex: EUR/kWh } }, bounded. */
function validPrices(prices, now) {
  const out = {};
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return out;
  const oldest = Math.floor((now - PRICE_HISTORY_DAYS * DAY) / QUARTER);
  for (const [key, slots] of Object.entries(prices).slice(0, 8)) {
    if (!KEY.test(key) || !slots || typeof slots !== 'object') continue;
    const kept = {};
    for (const [index, price] of Object.entries(slots).slice(0, 6000)) {
      const i = Number(index);
      if (Number.isInteger(i) && i >= oldest && finite(price) && Math.abs(price) <= 10)
        kept[i] = price;
    }
    out[key] = kept;
  }
  return out;
}

const bound = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const codeOf = (err) => (err instanceof KrakenError ? (err.kt ?? err.code) : 'bad_response');

export class OctopusApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    store = new FileStore(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = (n) => randomBytes(n),
    requestGap,
    requestTimeout,
    apiUrl,
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.requestGap = requestGap;
    this.requestTimeout = requestTimeout;
    this.apiUrl = apiUrl;

    this.gen = 0;
    this.stopped = false;
    this.stopEpoch = 0;
    this.config = normalizeConfig({});
    this.session = undefined;
    this.credKey = undefined;

    /** What /data keeps. */
    this.data = {
      lastAccount: null,
      lastConsumption: null,
      lastFull: null,
      pause: null,
      refused: null,
      meters: [],
      backfilled: [],
      prices: {},
    };
    this.storeState = 'pending';
    this.loading = null;
    this.storeTimer = null;
    this.pause = undefined;
    this.refused = undefined;

    /** The account read in this process (with the full MaLo numbers, memory only). */
    this.account = undefined;
    this.malos = [];
    this.charges = new Map();
    this.flex = [];
    this.dispatches = new Map();
    this.created = new Set();
    this.accountsFound = 0;
    this.accountProblem = undefined;

    this.lastAccountMono = undefined;
    this.lastConsumptionMono = undefined;
    this.lastDispatchMono = undefined;
    this.accountOkAt = undefined;
    this.accountOkMono = undefined;
    this.failures = 0;
    this.lastError = undefined;
    this.consumptionError = undefined;
    this.pendingBackfill = new Set();

    this.roundTimer = null;
    this.tickTimer = null;
    this.configTimer = null;
    this.configDelay = 0;
    this.running = Promise.resolve();
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.lastTest = undefined;
    this.dueMono = undefined;
    this.discoveredOnce = false;
    this.freshConfig = false;
  }

  gone(gen) {
    return this.stopped || gen !== this.gen;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every (re)connection to Gladys: read the config (retried for ever), then start. */
  async connected() {
    const epoch = this.stopEpoch;
    this.stopped = false;
    this.lastStatus = undefined;
    // What Gladys holds may be older than this process knows: published again.
    this.gladys.forgetPublishedStates?.();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped || epoch !== this.stopEpoch) return;
      this.configDelay = Math.min(
        CONFIG_RETRY_MAX,
        Math.max(CONFIG_RETRY_MIN, this.configDelay * 2),
      );
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, both('configUnread'));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        this.connected().catch((e) => this.log.error(`Start failed (${e?.name ?? 'Error'})`));
      }, this.configDelay);
      return;
    }
    if (this.stopped || epoch !== this.stopEpoch) return;
    this.configDelay = 0;
    await this.start(config);
  }

  async start(rawConfig) {
    this.stopped = false;
    const gen = ++this.gen;
    const config = normalizeConfig(rawConfig);
    const credentials = credentialsOf(config);
    const credKey = JSON.stringify([credentials, config.accountNumber]);
    const changed = credKey !== this.credKey;
    // Another login or account entered by the user: read soon (not at a restart).
    if (changed && this.credKey !== undefined) this.freshConfig = true;
    // Credentials changed in this process: always tried, even when their
    // 8-bit tag matches the refused one (a restart keeps the tag only).
    if (changed && this.credKey !== undefined && this.refused) {
      this.refused = undefined;
      this.data.refused = null;
    }
    this.config = config;
    if (changed || !this.session) {
      this.session?.close();
      this.session = config.problem
        ? undefined
        : new KrakenSession({
            credentials,
            fetchImpl: this.fetchImpl,
            monotonic: this.monotonic,
            sleep: (ms) => this.sleep(ms),
            ...(this.apiUrl ? { url: this.apiUrl } : {}),
            ...(this.requestTimeout ? { timeout: this.requestTimeout } : {}),
            ...(this.requestGap !== undefined ? { gap: this.requestGap } : {}),
          });
      this.credKey = credKey;
      if (changed) {
        // Another login: what was read belongs to the old one.
        this.account = undefined;
        this.malos = [];
        this.flex = [];
        this.dispatches.clear();
        this.failures = 0;
        this.lastError = undefined;
        this.accountProblem = undefined;
        this.accountsFound = 0;
      }
    }
    this.clearRound();
    await this.ready();
    if (this.gone(gen)) return;
    await this.refreshCreated(gen);
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen);
    if (this.gone(gen)) return;
    this.schedule(gen);
    this.armTick(gen);
    await this.publishPrices(gen);
    await this.report(gen);
  }

  async stop() {
    this.stopped = true;
    this.stopEpoch += 1;
    this.gen += 1;
    this.clearRound();
    for (const timer of [this.tickTimer, this.configTimer, this.storeTimer]) {
      if (timer) this.timers.clearTimeout(timer);
    }
    this.tickTimer = null;
    this.configTimer = null;
    this.storeTimer = null;
    this.session?.close();
    this.session = undefined;
    this.credKey = undefined;
    for (const wake of this.sleeps) wake();
    this.sleeps.clear();
    await this.running.catch(() => {});
    await this.save();
    await this.bounded(Promise.resolve(this.store.flush?.()), STORE_WAIT).catch(() => {});
  }

  /** `promise`, or TIMED_OUT after `ms` (the timer is cleared either way). */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => resolve(TIMED_OUT), ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Resolves after `ms` (injected timers), or at once when the app stops. */
  sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  // --- /data ----------------------------------------------------------------------

  /** Waits for /data at most STORE_WAIT; without it, nothing is ever saved. */
  async ready() {
    if (this.storeState === 'ok') return;
    const result = await this.bounded(this.loadStore(), STORE_WAIT);
    if (result === TIMED_OUT && this.storeState === 'pending') this.storeState = 'unreadable';
  }

  /** One read of /data at a time; an unreadable one is read again every STORE_RETRY. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = await this.store.load();
        const late = this.storeState === 'unreadable';
        this.merge(raw);
        this.storeState = 'ok';
        if (late) await this.afterLateLoad();
      } catch (err) {
        this.storeState = 'unreadable';
        this.log.warn(
          `/data unreadable (${err?.name ?? 'Error'}): read again in ${STORE_RETRY / 1000} s`,
        );
      } finally {
        this.loading = null;
      }
      if (this.storeState !== 'ok' && !this.stopped && !this.storeTimer) {
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = null;
          this.loadStore();
        }, STORE_RETRY);
      }
    })();
    return this.loading;
  }

  async afterLateLoad() {
    if (this.storeState !== 'ok' || this.stopped) return;
    const gen = this.gen;
    await this.save();
    if (this.gone(gen)) return;
    if (this.roundTimer) this.schedule(gen);
    await this.report(gen);
  }

  /** /data read back, merged with what this process learnt meanwhile (the stricter wins). */
  merge(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const now = this.now();
    const mono = this.monotonic();
    for (const key of ['lastAccount', 'lastConsumption']) {
      // A time of /data in the future is invalid: ignored.
      if (
        finite(data[key]) &&
        data[key] <= now &&
        !(finite(this.data[key]) && this.data[key] > data[key])
      ) {
        this.data[key] = data[key];
      }
    }
    if (
      typeof data.lastFull === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.lastFull) &&
      !this.data.lastFull
    ) {
      this.data.lastFull = data.lastFull;
    }
    const pause = validPause(data.pause, now, mono);
    if (pause && !(this.pause && this.pause.until >= pause.until)) {
      this.pause = pause;
      this.data.pause = {
        until: pause.until,
        count: pause.count,
        code: pause.code,
        detail: pause.detail,
      };
    }
    const refused = validRefused(data.refused);
    if (refused && !this.refused) {
      this.refused = refused;
      this.data.refused = refused;
    }
    if (!this.data.meters.length) this.data.meters = validMeters(data.meters);
    const backfilled = Array.isArray(data.backfilled)
      ? data.backfilled.filter((k) => KEY.test(k)).slice(0, 16)
      : [];
    this.data.backfilled = [...new Set([...this.data.backfilled, ...backfilled])];
    const kept = validPrices(data.prices, now);
    for (const [key, slots] of Object.entries(kept)) {
      this.data.prices[key] = { ...slots, ...(this.data.prices[key] ?? {}) };
    }
  }

  async save() {
    if (this.storeState !== 'ok') return false;
    const snapshot = {
      version: 1,
      lastAccount: this.data.lastAccount,
      lastConsumption: this.data.lastConsumption,
      lastFull: this.data.lastFull,
      pause: this.data.pause,
      refused: this.data.refused,
      meters: this.data.meters,
      backfilled: this.data.backfilled,
      prices: this.data.prices,
    };
    try {
      // A slow volume never holds a read: the write goes on in the background.
      const done = this.store.save(snapshot);
      done.catch((err) => this.log.warn(`/data not saved (${err?.name ?? 'Error'})`));
      return (
        (await this.bounded(
          done.then(() => true),
          STORE_WAIT,
        )) === true
      );
    } catch (err) {
      this.log.warn(`/data not saved (${err?.name ?? 'Error'})`);
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------------

  clearRound() {
    if (this.roundTimer) {
      this.timers.clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
  }

  pauseActive(mono = this.monotonic()) {
    return Boolean(this.pause && this.pause.due > mono);
  }

  isRefused() {
    return Boolean(
      this.refused && this.refused.tag === tagOf(this.refused.salt, credentialsOf(this.config)),
    );
  }

  /** The monotonic time a kind of read is due, from this process or from /data. */
  dueOf(lastMono, lastWall, interval, mono, now) {
    if (lastMono !== undefined) return lastMono + interval;
    // /data not read: its last read is unknown, a whole interval is waited.
    if (this.storeState !== 'ok') return mono + interval;
    return finite(lastWall) && lastWall <= now
      ? mono + Math.max(0, interval - (now - lastWall))
      : mono;
  }

  accountDue(mono, now) {
    const wait = this.freshConfig
      ? CREATED_MIN_GAP
      : this.failures > 0
        ? Math.min(RETRY_MAX, RETRY_MIN * 2 ** (this.failures - 1))
        : ACCOUNT_INTERVAL;
    return this.dueOf(this.lastAccountMono, this.data.lastAccount, wait, mono, now);
  }

  consumptionDue(mono, now) {
    if (!this.consumptionTargets().length) return Infinity;
    const due = this.dueOf(
      this.lastConsumptionMono,
      this.data.lastConsumption,
      CONSUMPTION_INTERVAL,
      mono,
      now,
    );
    // A new meter device: soon, but never sooner than CREATED_MIN_GAP after a read.
    if (this.consumptionTargets().some((m) => this.pendingBackfill.has(m.key))) {
      return Math.min(
        due,
        this.dueOf(this.lastConsumptionMono, this.data.lastConsumption, CREATED_MIN_GAP, mono, now),
      );
    }
    return due;
  }

  dispatchDue(mono) {
    if (!this.flexTargets().length) return Infinity;
    return this.lastDispatchMono === undefined ? mono : this.lastDispatchMono + DISPATCH_INTERVAL;
  }

  /** The next round: when the first kind of read is due, never during a pause or a refusal. */
  schedule(gen) {
    if (this.gone(gen)) return;
    this.clearRound();
    if (!this.session || this.isRefused()) {
      this.dueMono = undefined;
      return;
    }
    const mono = this.monotonic();
    const now = this.now();
    let due = this.accountDue(mono, now);
    // The consumption and the charges need an account read in this process.
    if (this.account) due = Math.min(due, this.consumptionDue(mono, now), this.dispatchDue(mono));
    if (this.pause) due = Math.max(due, this.pause.due);
    this.dueMono = Math.max(due, mono);
    this.roundTimer = this.timers.setTimeout(() => {
      this.roundTimer = null;
      this.running = this.round(gen).catch((err) =>
        this.log.error(`Round failed (${err?.name ?? 'Error'})`),
      );
    }, this.dueMono - mono);
  }

  /** The price features again at every quarter of an hour (no request). */
  armTick(gen) {
    if (this.tickTimer) this.timers.clearTimeout(this.tickTimer);
    const now = this.now();
    // On the next quarter (wall clock: the tariff slots are), a second after it.
    const wait = Math.min(TICK, QUARTER - (now % QUARTER) + 1000);
    this.tickTimer = this.timers.setTimeout(() => {
      this.tickTimer = null;
      if (this.gone(gen)) return;
      this.publishPrices(gen)
        .catch(() => {})
        .then(() => {
          if (!this.gone(gen)) this.armTick(gen);
        });
    }, wait);
  }

  // --- Reads -------------------------------------------------------------------------

  async round(gen) {
    if (this.gone(gen) || !this.session || this.isRefused()) return;
    if (this.pauseActive()) {
      this.schedule(gen);
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    try {
      if (!this.account || this.accountDue(mono, now) <= mono) {
        await this.readAccount(gen);
      }
      if (this.gone(gen)) return;
      if (
        this.account &&
        !this.pauseActive() &&
        this.consumptionDue(this.monotonic(), this.now()) <= this.monotonic()
      ) {
        await this.readConsumption(gen);
      }
      if (this.gone(gen)) return;
      if (
        this.account &&
        !this.pauseActive() &&
        this.dispatchDue(this.monotonic()) <= this.monotonic()
      ) {
        await this.readDispatches(gen);
      }
    } catch (err) {
      if (this.gone(gen)) return;
      await this.failed(gen, err);
    }
    if (this.gone(gen)) return;
    this.schedule(gen);
    await this.report(gen);
  }

  /** A read failed: a refusal, a pause or a passing error (retried later). */
  async failed(gen, err) {
    const code = err instanceof KrakenError ? err.code : 'bad_response';
    if (code === 'stopped') return;
    if (code === 'refused' || code === 'api_access') {
      await this.refuse(err);
      return;
    }
    if (PAUSING.has(code)) {
      await this.setPause(err);
      return;
    }
    this.lastError = codeOf(err);
    this.log.warn(`Octopus not read (${this.lastError})`);
  }

  async refuse(err) {
    const salt = this.random(16).toString('hex');
    this.refused = {
      salt,
      tag: tagOf(salt, credentialsOf(this.config)),
      code: err.code === 'api_access' ? 'api_access' : 'refused',
      kt: err.kt ?? null,
    };
    this.data.refused = this.refused;
    this.log.warn(
      `Octopus refused the login (${err.kt ?? err.code}): no request until the credentials change or Test succeeds`,
    );
    this.clearRound();
    await this.save();
  }

  async setPause(err) {
    const now = this.now();
    const mono = this.monotonic();
    const count = Math.min((this.pause?.code === err.code ? this.pause.count : 0) + 1, 16);
    const base =
      err.code === 'rate_limited'
        ? RATE_LIMIT_PAUSE
        : err.code === 'login_blocked'
          ? LOGIN_BLOCK_PAUSE
          : SERVER_PAUSE;
    const asked = finite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 0;
    const ms = Math.min(PAUSE_MAX, Math.max(asked, base * 2 ** (count - 1)));
    const detail = err.kt ?? (err.status ? `HTTP ${err.status}` : null);
    this.pause = { until: now + ms, due: mono + ms, count, code: err.code, detail };
    this.data.pause = { until: now + ms, count, code: err.code, detail };
    this.log.warn(`Octopus paused until ${clock(now + ms)} (${detail ?? err.code})`);
    await this.save();
  }

  /** A request answered: the pause is over and its count forgotten. */
  async clearPause() {
    if (!this.pause && !this.data.pause) return;
    this.pause = undefined;
    this.data.pause = null;
    await this.save();
  }

  async readAccount(gen) {
    const session = this.session;
    // The attempt is kept BEFORE the request: a restart never reads sooner.
    this.freshConfig = false;
    this.lastAccountMono = this.monotonic();
    this.data.lastAccount = this.now();
    await this.save();
    if (this.gone(gen)) return;
    let numbers;
    try {
      const { data } = await session.request(ACCOUNTS);
      numbers = parseAccounts(data).slice(0, MAX_ACCOUNTS);
    } catch (err) {
      this.failures += 1;
      throw err;
    }
    if (this.gone(gen)) return;
    await this.clearPause();
    this.accountsFound = numbers.length;
    const wanted = this.config.accountNumber;
    const number = wanted ? numbers.find((n) => n === wanted) : numbers[0];
    if (!number) {
      this.failures = 0;
      this.lastError = undefined;
      this.accountProblem = numbers.length ? 'unknownAccount' : 'noAccount';
      return;
    }
    let malos;
    try {
      const { data } = await session.request(ACCOUNT, { accountNumber: number });
      malos = parseAccount(data);
      if (!malos) throw new KrakenError('bad_response');
    } catch (err) {
      this.failures += 1;
      throw err;
    }
    if (this.gone(gen)) return;
    this.failures = 0;
    this.lastError = undefined;
    this.accountProblem = malos.length ? undefined : 'noMalo';
    this.account = { number, several: !wanted && numbers.length > 1 };
    this.malos = malos;
    this.accountOkAt = this.now();
    this.accountOkMono = this.monotonic();
    this.recordPrices();
    // Secondary reads: a failure keeps what was known, never blocks the tariffs.
    try {
      const { data } = await session.request(STANDING_CHARGES, { accountNumber: number });
      this.charges = parseStandingCharges(data);
    } catch (err) {
      if (PAUSING.has(err?.code) || err?.code === 'stopped') throw err;
      this.log.warn(`Standing charges not read (${codeOf(err)})`);
    }
    if (this.gone(gen)) return;
    try {
      const { data } = await session.request(DEVICES, { accountNumber: number });
      const devices = parseDevices(data);
      if (devices) this.flex = devices;
    } catch (err) {
      if (PAUSING.has(err?.code) || err?.code === 'stopped') throw err;
      // No Intelligent device on most accounts: the API may answer an error.
      if (err?.code !== 'graphql' && err?.code !== 'unauthorized') {
        this.log.warn(`Intelligent devices not read (${codeOf(err)})`);
      }
    }
    if (this.gone(gen)) return;
    const meters = this.malos.map((m) => ({
      key: m.key,
      suffix: m.suffix,
      smart: m.smart,
      tariff: labelAt(m.agreements, this.now())?.slice(0, 64) ?? '',
    }));
    const changed = JSON.stringify(meters) !== JSON.stringify(this.data.meters);
    this.data.meters = meters;
    await this.save();
    if (this.gone(gen)) return;
    if (changed || !this.discoveredOnce) await this.publishDiscovery(gen);
    await this.publishPrices(gen);
  }

  /** The prices of the quarters from yesterday to the end of what is known, kept in /data. */
  recordPrices() {
    const now = this.now();
    const oldest = Math.floor((now - PRICE_HISTORY_DAYS * DAY) / QUARTER);
    for (const m of this.malos) {
      const kept = this.data.prices[m.key] ?? {};
      const from = addDays(now, -1);
      const end = Math.min(now + 3 * DAY, Math.max(now + DAY, forecastEnd(m.agreements, now) ?? 0));
      for (let q = from; q < end; q += QUARTER) {
        const price = priceAt(m.agreements, q);
        if (price !== undefined) kept[Math.floor(q / QUARTER)] = price;
      }
      for (const index of Object.keys(kept)) if (Number(index) < oldest) delete kept[index];
      this.data.prices[m.key] = kept;
    }
    for (const key of Object.keys(this.data.prices)) {
      if (!this.malos.some((m) => m.key === key) && !this.data.meters.some((m) => m.key === key)) {
        delete this.data.prices[key];
      }
    }
  }

  /** The created meter devices with a consumption feature, among the MaLos read. */
  consumptionTargets() {
    return this.malos.filter(
      (m) =>
        m.smart &&
        this.created.has(idsOf(this.gladys, KIND.MALO, m.key).feature(FEATURE.CONSUMPTION)),
    );
  }

  flexTargets() {
    return this.flex.filter((d) => this.created.has(idsOf(this.gladys, KIND.FLEX, d.key).device));
  }

  async readConsumption(gen) {
    const session = this.session;
    const now = this.now();
    this.lastConsumptionMono = this.monotonic();
    this.data.lastConsumption = now;
    const today = localDate(now);
    const full = this.data.lastFull !== today && berlin(now).h >= BACKFILL_HOUR;
    await this.save();
    if (this.gone(gen)) return;
    let problem;
    for (const m of this.consumptionTargets()) {
      const backfill = full || !this.data.backfilled.includes(m.key);
      const days = backfill ? BACKFILL_DAYS : CONSUMPTION_DAYS;
      const from = addDays(now, -days);
      const to = now - (now % QUARTER);
      const into = { quarters: new Map(), conflicts: new Set() };
      let after;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const { data } = await session.request(MEASUREMENTS, {
            propertyId: m.propertyId,
            first: PAGE_SIZE,
            after: after ?? null,
            utilityFilters: [
              {
                electricityFilters: {
                  marketSupplyPointId: m.malo,
                  readingFrequencyType: 'RAW_INTERVAL',
                },
              },
            ],
            startAt: new Date(from).toISOString(),
            endAt: new Date(to).toISOString(),
            timezone: TIME_ZONE,
          });
          if (this.gone(gen)) return;
          if (!parseMeasurements(data, m.malo, into)) throw new KrakenError('bad_response');
          if (!into.next || into.next === after) break;
          after = into.next;
        }
      } catch (err) {
        if (PAUSING.has(err?.code) || err?.code === 'stopped' || err?.code === 'refused') throw err;
        // One meter failing never stops the others.
        problem = codeOf(err);
        this.log.warn(`Consumption not read (${problem})`);
        continue;
      }
      const intervals = halfHours(into.quarters, this.now());
      const feature = idsOf(this.gladys, KIND.MALO, m.key).feature(FEATURE.CONSUMPTION);
      try {
        for (let i = 0; i < intervals.length; i += 2000) {
          await this.gladys.publishEnergyConsumption(feature, intervals.slice(i, i + 2000));
          if (this.gone(gen)) return;
        }
        this.pendingBackfill.delete(m.key);
        if (!this.data.backfilled.includes(m.key)) this.data.backfilled.push(m.key);
      } catch (err) {
        problem = 'gladys';
        this.log.warn(`Consumption not published (${err?.name ?? 'Error'})`);
      }
    }
    if (this.gone(gen)) return;
    await this.clearPause();
    this.consumptionError = problem;
    if (full && !problem) this.data.lastFull = today;
    await this.save();
  }

  async readDispatches(gen) {
    const session = this.session;
    this.lastDispatchMono = this.monotonic();
    for (const d of this.flexTargets()) {
      try {
        const { data } = await session.request(dispatchesOf(d.id));
        if (this.gone(gen)) return;
        const list = parseDispatches(data);
        if (list) this.dispatches.set(d.key, { list, at: this.monotonic() });
      } catch (err) {
        if (PAUSING.has(err?.code) || err?.code === 'stopped' || err?.code === 'refused') throw err;
        this.log.warn(`Planned charges not read (${codeOf(err)})`);
      }
    }
    if (this.gone(gen)) return;
    await this.publishPrices(gen);
  }

  // --- Gladys --------------------------------------------------------------------------

  async refreshCreated(gen) {
    try {
      const devices = await this.bounded(Promise.resolve(this.gladys.getDevices()), 10_000);
      if (this.gone(gen) || devices === TIMED_OUT || !Array.isArray(devices)) return;
      this.created = new Set();
      for (const d of devices) this.addCreated(d);
    } catch (err) {
      this.log.warn(`Devices not read from Gladys (${err?.name ?? 'Error'})`);
    }
  }

  addCreated(device) {
    if (!parseDeviceId(device?.external_id)) return;
    this.created.add(device.external_id);
    for (const f of device.features ?? []) if (f?.external_id) this.created.add(f.external_id);
  }

  async onDeviceCreated(device) {
    const id = parseDeviceId(device?.external_id);
    if (!id) return;
    this.addCreated(device);
    const gen = this.gen;
    if (id.kind === KIND.MALO && !this.data.backfilled.includes(id.key))
      this.pendingBackfill.add(id.key);
    // Its values from what is held, then its reads when due (never a burst).
    await this.publishPrices(gen);
    if (!this.gone(gen) && this.roundTimer) this.schedule(gen);
  }

  onDeviceDeleted(device) {
    const id = parseDeviceId(device?.external_id);
    if (!id) return;
    for (const f of device.features ?? []) this.created.delete(f?.external_id);
    this.created.delete(device.external_id);
    this.pendingBackfill.delete(id.key);
  }

  /** The devices offered in Discovery: what was read, else what /data remembers. Never a request. */
  async publishDiscovery(gen) {
    const meters = this.malos.length
      ? this.malos.map((m) => ({ ...m, tariff: labelAt(m.agreements, this.now()) }))
      : this.data.meters;
    const devices = [
      ...meters.map((m) => buildMaloDevice(this.gladys, m)),
      ...this.flex.map((d) => buildFlexDevice(this.gladys, d)),
    ];
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      if (!this.gone(gen)) this.discoveredOnce = true;
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  async scan() {
    await this.publishDiscovery(this.gen);
  }

  /** The agreements of a MaLo key, when read recently enough in this process. */
  freshMalo(key) {
    if (
      this.accountOkMono === undefined ||
      this.monotonic() - this.accountOkMono > PRICES_MAX_AGE
    ) {
      return undefined;
    }
    return this.malos.find((m) => m.key === key);
  }

  /** The price of the quarter starting at `q`: the agreements, else the prices kept. */
  priceFor(key, q, malo = this.malos.find((m) => m.key === key)) {
    const live = malo ? priceAt(malo.agreements, q) : undefined;
    return live ?? this.data.prices[key]?.[Math.floor(q / QUARTER)];
  }

  /** The next change of price after the quarter `q` (within 2 days): { at, price }. */
  nextChange(key, q, price, malo) {
    for (let at = q + QUARTER; at < q + 2 * DAY; at += QUARTER) {
      const p = this.priceFor(key, at, malo);
      if (p === undefined) return { at, price: undefined };
      if (p !== price) return { at, price: p };
    }
    return undefined;
  }

  /** The price features of the created devices, from what is held (no request). */
  async publishPrices(gen) {
    if (this.gone(gen)) return;
    const now = this.now();
    const q = now - (now % QUARTER);
    const states = [];
    for (const m of this.malos) {
      const ids = idsOf(this.gladys, KIND.MALO, m.key);
      if (!this.created.has(ids.device) || !this.freshMalo(m.key)) continue;
      const price = this.priceFor(m.key, q, m);
      const next = price === undefined ? undefined : this.nextChange(m.key, q, price, m);
      states.push(
        ...priceStates(ids, {
          price,
          // No change within 2 days: the same price; a next price unknown stays unknown.
          nextPrice: next ? next.price : price,
          standingCharge: standingChargeAt(m.agreements, this.charges, now),
        }),
      );
    }
    const mono = this.monotonic();
    for (const d of this.flex) {
      const ids = idsOf(this.gladys, KIND.FLEX, d.key);
      const held = this.dispatches.get(d.key);
      // Planned charges read more than an hour ago are not published as current.
      if (!this.created.has(ids.device) || !held || mono - held.at > HOUR) continue;
      const active = held.list.some((x) => x.start <= now && now < x.end);
      states.push({
        device_feature_external_id: ids.feature(FEATURE.DISPATCHING),
        state: active ? 1 : 0,
      });
    }
    if (!states.length) return;
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.log.warn(`States not published (${err?.name ?? 'Error'})`);
    }
  }

  // --- Energy contracts (delegated) ------------------------------------------------------

  /** The MaLo of a contract: the one ending with the suffix entered, else the only/first one. */
  contractMalo(inputs) {
    const known = this.malos.length ? this.malos : this.data.meters;
    const raw = typeof inputs?.malo_suffix === 'string' ? inputs.malo_suffix.trim() : '';
    if (!raw) return known[0];
    if (!/^[A-Za-z0-9]{1,4}$/.test(raw)) return undefined;
    const matches = known.filter((m) => m.suffix.toUpperCase().endsWith(raw.toUpperCase()));
    // Two MaLos ending alike: never a guess, the contract is not priced.
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * The cost of every interval (30 min): its kWh at the mean of its two
   * quarter prices, VAT included; a negative price costs 0 (a cost is >= 0).
   * One price unknown: the whole request fails (the core retries later),
   * never a silent zero. No request: what is held only.
   */
  energyPrice({ contract, intervals }) {
    const m = this.contractMalo(contract?.inputs);
    if (!m) throw new Error('No Octopus electricity market location matches this contract');
    const malo = this.malos.find((x) => x.key === m.key);
    return (intervals ?? []).map(({ starts_at: startsAt, kwh }) => {
      const t0 = Date.parse(startsAt);
      const p1 = this.priceFor(m.key, t0, malo);
      const p2 = this.priceFor(m.key, t0 + QUARTER, malo);
      if (!Number.isFinite(t0) || p1 === undefined || p2 === undefined || !finite(kwh) || kwh < 0) {
        throw new Error(`No Octopus price known for ${startsAt}`);
      }
      const cost = Math.max(0, (kwh * (p1 + p2)) / 2);
      const label = malo ? labelAt(malo.agreements, t0) : undefined;
      return {
        starts_at: startsAt,
        cost: Math.round(cost * 1e8) / 1e8,
        ...(label ? { label: label.slice(0, 64) } : {}),
      };
    });
  }

  energyCurrent({ contract }) {
    const m = this.contractMalo(contract?.inputs);
    if (!m) return { price: null };
    const malo = this.freshMalo(m.key);
    const now = this.now();
    const q = now - (now % QUARTER);
    const price = this.priceFor(m.key, q, malo);
    if (price === undefined) return { price: null };
    const next = this.nextChange(m.key, q, price, malo);
    const label = malo ? labelAt(malo.agreements, q) : undefined;
    const nextLabel = malo && next ? labelAt(malo.agreements, next.at) : undefined;
    return {
      price,
      valid_until: next ? new Date(next.at).toISOString() : null,
      next_price: next?.price ?? null,
      ...(label ? { label: label.slice(0, 64) } : {}),
      ...(nextLabel ? { next_label: nextLabel.slice(0, 64) } : {}),
    };
  }

  // --- Status ------------------------------------------------------------------------

  async report(gen = this.gen) {
    if (this.gone(gen)) return;
    const [connected, message] = this.statusNow();
    if (this.storeState !== 'ok' && this.storeState !== 'pending') {
      for (const lang of ['en', 'fr']) message[lang] += t('storage', lang);
    }
    for (const lang of ['en', 'fr']) message[lang] = bound(message[lang].trim(), MAX_STATUS);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    await this.setStatus(connected, message, key);
  }

  async setStatus(connected, message, key = JSON.stringify([connected, message])) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  nextTime() {
    const wait = Math.max(0, (this.dueMono ?? this.monotonic()) - this.monotonic());
    // Rounded up: never a time before the read.
    return clock(this.now() + wait + 999);
  }

  statusNow() {
    if (this.config.problem) return [false, both(this.config.problem)];
    if (this.isRefused()) {
      return [
        false,
        this.refused.code === 'api_access'
          ? both('apiAccess')
          : both('refused', { code: this.refused.kt ?? 'refused' }),
      ];
    }
    if (this.pauseActive()) {
      const key =
        this.pause.code === 'rate_limited'
          ? 'rateLimited'
          : this.pause.code === 'login_blocked'
            ? 'loginBlocked'
            : 'server';
      return [
        false,
        both(key, { time: clock(this.pause.until), code: this.pause.detail ?? this.pause.code }),
      ];
    }
    if (this.accountProblem) return [false, both(this.accountProblem)];
    if (!this.account) {
      return this.lastError
        ? [false, both('failing', { code: this.lastError, time: this.nextTime() })]
        : [false, both('starting', { time: this.nextTime() })];
    }
    const message = both('connected', { count: this.malos.length, time: clock(this.accountOkAt) });
    const add = (key, values) => {
      for (const lang of ['en', 'fr']) message[lang] += t(key, lang, values);
    };
    if (this.lastError) add('lastFailed', { code: this.lastError, time: this.nextTime() });
    if (this.consumptionError) add('consumptionFailed', { code: this.consumptionError });
    if (this.account.several) add('severalAccounts');
    return [!this.lastError, message];
  }

  // --- Test button ------------------------------------------------------------------------

  /** A login and the list of accounts: lifts a refusal on success. */
  async testConnection() {
    if (this.config.problem) return both(this.config.problem);
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TEST_MIN_GAP)
      return both('testTooSoon');
    if (this.pauseActive(mono)) return both('testPaused', { time: clock(this.pause.until) });
    const session = this.session;
    if (!session) return both('missing');
    const gen = this.gen;
    this.lastTest = mono;
    let message;
    try {
      const { data } = await session.request(ACCOUNTS);
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      message = both('testOk', { count: parseAccounts(data).length });
      await this.clearPause();
      if (this.refused) {
        this.refused = undefined;
        this.data.refused = null;
        await this.save();
      }
      if (!this.gone(gen) && !this.roundTimer) this.schedule(gen);
    } catch (err) {
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      const code = err instanceof KrakenError ? err.code : 'bad_response';
      if (code === 'refused' || code === 'api_access') {
        await this.refuse(err);
        message =
          code === 'api_access'
            ? both('apiAccess')
            : both('refused', { code: err.kt ?? 'refused' });
      } else if (PAUSING.has(code)) {
        await this.setPause(err);
        message = both('testPaused', { time: clock(this.pause.until) });
      } else {
        message = both('testFailed', { code: codeOf(err) });
      }
    }
    await this.report(gen);
    return message;
  }
}
