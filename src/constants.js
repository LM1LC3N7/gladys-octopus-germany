// -----------------------------------------------------------------------------
// Constants of the Octopus Energy Germany integration: the endpoint, the pace,
// the bounds and the manifest keys (forever: stored in user configs and
// contracts).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The official Kraken GraphQL API of Octopus Energy Germany (developer.oeg-kraken.energy). */
export const API_URL = 'https://api.oeg-kraken.energy/v1/graphql/';
// The version follows the release (package.json is in the image).
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const USER_AGENT = `gladys-octopus-germany/${VERSION} (+https://github.com/LM1LC3N7/gladys-octopus-germany)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const QUARTER = 15 * MINUTE;
export const HALF_HOUR = 30 * MINUTE;

export const TIME_ZONE = 'Europe/Berlin';
export const CURRENCY = 'EUR';

// --- Requests -----------------------------------------------------------------

/** One request never takes longer (headers and body). */
export const REQUEST_TIMEOUT = 20 * SECOND;
/** A larger answer is cut before it is read whole (an account answers a few kB). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Two requests of the integration are always this far apart (one in flight at a time). */
export const REQUEST_GAP = 2 * SECOND;
/** The measurements come by pages of 100 quarters; never more pages for one read. */
export const PAGE_SIZE = 100;
export const MAX_PAGES = 12;

// --- Pace -----------------------------------------------------------------------

/** The account (meters, tariffs, the dynamic prices ahead) is read every hour. */
export const ACCOUNT_INTERVAL = HOUR;
/** The consumption of the created meters: every 3 hours, the last 3 days. */
export const CONSUMPTION_INTERVAL = 3 * HOUR;
export const CONSUMPTION_DAYS = 3;
/** Once a day (the first read after 06:00 in Germany) and for a new meter: 7 days. */
export const BACKFILL_DAYS = 7;
export const BACKFILL_HOUR = 6;
/** The planned charges of the created Intelligent devices: every 15 minutes. */
export const DISPATCH_INTERVAL = 15 * MINUTE;
/** After a failed read: again after 5, 10, 20, 40 then every 60 minutes. */
export const RETRY_MIN = 5 * MINUTE;
export const RETRY_MAX = HOUR;
/** A 429 / KT-CT-1199 without Retry-After: 15 minutes, doubled up to 6 hours. */
export const RATE_LIMIT_PAUSE = 15 * MINUTE;
/** A 5xx: 5 minutes, doubled up to 6 hours. */
export const SERVER_PAUSE = 5 * MINUTE;
/** A login Octopus blocks for a while (KT-CT-1136): 1 hour, doubled up to 6 hours. */
export const LOGIN_BLOCK_PAUSE = HOUR;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers at most once a minute with a new request. */
export const TEST_MIN_GAP = MINUTE;
/** A new meter device is read at once, but never sooner than this after another read. */
export const CREATED_MIN_GAP = MINUTE;
/** The config is read again after a failure: 5 s doubled up to 5 minutes, for ever. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** /data: waited at most STORE_WAIT; an unreadable one is read again every STORE_RETRY. */
export const STORE_WAIT = 3 * SECOND;
export const STORE_RETRY = 10 * SECOND;
/** A token is renewed this long before its end (or at 80 % of its life when shorter). */
export const TOKEN_MARGIN = 5 * MINUTE;
/** A token without a readable lifetime is used this long. */
export const TOKEN_DEFAULT_LIFE = 50 * MINUTE;
/** The price features are published again at every quarter of an hour (no request). */
export const TICK = QUARTER;
/** Prices read longer ago than this are not published as current any more. */
export const PRICES_MAX_AGE = 6 * HOUR;

// --- Bounds -----------------------------------------------------------------------

/** Prices kept in /data to price the past intervals: 40 days of quarters. */
export const PRICE_HISTORY_DAYS = 40;
/** At most this many accounts, meters, agreements, devices are read from one answer. */
export const MAX_ACCOUNTS = 10;
export const MAX_METERS = 8;
export const MAX_AGREEMENTS = 50;
export const MAX_FORECAST = 1000;
export const MAX_FLEX_DEVICES = 4;
export const MAX_DISPATCHES = 100;
/** A gross price beyond ± this (EUR/kWh) is not a price. */
export const MAX_PRICE = 10;
/** A quarter beyond this (kWh) is not a household reading. */
export const MAX_QUARTER_KWH = 250;
export const MAX_STATUS = 400;

// --- Manifest keys (forever) -------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };
export const TEMPLATES = { ELECTRICITY: 'octopus-de-electricity' };
