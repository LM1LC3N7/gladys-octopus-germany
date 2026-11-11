// -----------------------------------------------------------------------------
// The Gladys devices (pure). Read-only features only: nothing is commanded.
//
// External ids (forever):
//   ext:<selector>:malo:<key>     an electricity market location (MaLo) of the
//                                 account; key = 16 hex digits of an HMAC-SHA-256
//                                 of the MaLo number under the id key kept in the
//                                 Gladys config (the number itself is never
//                                 in an id, a log, a status or /data). The
//                                 MaLo, not the meter: a replaced meter keeps
//                                 its Gladys device and history.
//   ext:<selector>:flex:<key>     an Intelligent Octopus device (car, charge
//                                 point); key = the same HMAC of its Kraken id.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { MAX_PRICE } from './constants.js';
import { t } from './i18n.js';

export const KIND = Object.freeze({ MALO: 'malo', FLEX: 'flex' });
export const FEATURE = Object.freeze({
  PRICE: 'price',
  NEXT_PRICE: 'next_price',
  STANDING_CHARGE: 'standing_charge',
  CONSUMPTION: 'consumption',
  DISPATCHING: 'dispatching',
});

export const idsOf = (gladys, kind, key) => gladys.externalIds(kind, key);

/** `{ kind, key }` of one of our device external ids; undefined otherwise. */
export function parseDeviceId(externalId) {
  const match = /:(malo|flex):([0-9a-f]{16})$/.exec(String(externalId ?? ''));
  return match ? { kind: match[1], key: match[2] } : undefined;
}

const sensor = (ids, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(key),
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

const money = (ids, key, name, min, max) =>
  sensor(ids, key, name, C.CURRENCY, T.CURRENCY.DECIMAL, { unit: U.EURO, min, max });

/** The device of an electricity MaLo: `{ key, suffix, smart, tariff }`. */
export function buildMaloDevice(gladys, malo, language = 'en') {
  const ids = idsOf(gladys, KIND.MALO, malo.key);
  const features = [
    money(ids, FEATURE.PRICE, t('featurePrice', language), -MAX_PRICE, MAX_PRICE),
    money(ids, FEATURE.NEXT_PRICE, t('featureNextPrice', language), -MAX_PRICE, MAX_PRICE),
    money(ids, FEATURE.STANDING_CHARGE, t('featureStandingCharge', language), 0, 1000),
  ];
  if (malo.smart) {
    features.push(
      sensor(
        ids,
        FEATURE.CONSUMPTION,
        t('featureConsumption', language),
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
        { unit: U.KILOWATT_HOUR, max: 500 },
      ),
    );
  }
  return {
    name: t('deviceMalo', language, { suffix: malo.suffix }),
    external_id: ids.device,
    features,
    params: [
      { name: 'malo_suffix', value: malo.suffix },
      { name: 'tariff', value: malo.tariff ?? '' },
    ],
  };
}

/** The device of an Intelligent Octopus device: `{ key, name, type }`. */
export function buildFlexDevice(gladys, device, language = 'en') {
  const ids = idsOf(gladys, KIND.FLEX, device.key);
  return {
    name: t('deviceFlex', language, { name: device.name || device.type || 'Intelligent' }),
    external_id: ids.device,
    features: [
      sensor(
        ids,
        FEATURE.DISPATCHING,
        t('featureDispatching', language),
        C.UNKNOWN,
        T.SENSOR.BINARY,
        {
          keep_history: true,
        },
      ),
    ],
    params: [{ name: 'device_type', value: device.type ?? '' }],
  };
}

const round = (v) => Math.round(v * 1e5) / 1e5;

/** The price states of a MaLo device; a value unknown is left out (never 0). */
export function priceStates(ids, { price, nextPrice, standingCharge }) {
  const out = [];
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ device_feature_external_id: ids.feature(key), state: round(value) });
    }
  };
  add(FEATURE.PRICE, price);
  add(FEATURE.NEXT_PRICE, nextPrice);
  add(FEATURE.STANDING_CHARGE, standingCharge);
  return out;
}
