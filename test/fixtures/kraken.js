// -----------------------------------------------------------------------------
// Kraken answers shaped after the schema of developer.oeg-kraken.energy and
// the queries of octopus_germany (no real account was available: every value
// is made up; the MaLo number is a fake 11-digit one).
// -----------------------------------------------------------------------------

export const EMAIL = 'kunde@example.com';
export const PASSWORD = 'S3cret-Pass word!';
export const ACCOUNT_NUMBER = 'A-1B2C3D4E';
export const MALO = '50412345678';
export const PROPERTY_ID = '987654';
/** Wednesday 2026-11-04 10:07 in Germany (UTC+1): in the past (the fake Gladys checks elapsed intervals on the real clock). */
export const NOW = Date.UTC(2026, 10, 4, 9, 7);

export const ok = (data) => ({ data });
export const ktError = (code, data = null) => ({
  data,
  errors: [{ message: 'Something about kunde@example.com', extensions: { errorCode: code } }],
});

let serial = 0;
export function token({ life = 3600, refresh = true } = {}) {
  serial += 1;
  const iat = 1_800_000_000 + serial;
  return ok({
    obtainKrakenToken: {
      token: `tok-${String(serial).padStart(4, '0')}-AAAAAAAAAAAAAAAAAAAA`,
      payload: { exp: iat + life, iat, email: EMAIL },
      refreshToken: refresh ? `ref-${String(serial).padStart(4, '0')}-BBBBBBBBBBBBBBBB` : null,
      refreshExpiresIn: refresh ? iat + 7 * 86400 : null,
    },
  });
}

export const accounts = (numbers = [ACCOUNT_NUMBER]) =>
  ok({ viewer: { accounts: numbers.map((number) => ({ number })) } });

const rate = (cents, date = '2026-01-01', to = null) => ({
  latestGrossUnitRateCentsPerKwh: String(cents),
  grossRateInformation: [{ date, grossRate: String(cents), rateValidToDate: to }],
});

export const simpleAgreement = ({
  id = '111',
  cents = 29.5,
  from = '2026-01-01T00:00:00+01:00',
  to = null,
} = {}) => ({
  id,
  validFrom: from,
  validTo: to,
  isRevoked: false,
  product: { code: 'OE-FIX-12M', fullName: 'Octopus 12M Fix', isTimeOfUse: false },
  unitRateInformation: { __typename: 'SimpleProductUnitRateInformation', ...rate(cents) },
  unitRateForecast: [],
});

export const goAgreement = ({
  id = '222',
  go = 19,
  standard = 31,
  from = '2026-01-01T00:00:00+01:00',
} = {}) => ({
  id,
  validFrom: from,
  validTo: null,
  isRevoked: false,
  product: { code: 'INTELLI-GO-DE', fullName: 'Intelligent Octopus Go', isTimeOfUse: true },
  unitRateInformation: {
    __typename: 'TimeOfUseProductUnitRateInformation',
    rates: [
      {
        timeslotName: 'GO',
        ...rate(go),
        timeslotActivationRules: [{ activeFromTime: '00:00:00', activeToTime: '05:00:00' }],
      },
      {
        timeslotName: 'STANDARD',
        ...rate(standard),
        timeslotActivationRules: [{ activeFromTime: '05:00:00', activeToTime: '00:00:00' }],
      },
    ],
  },
  unitRateForecast: [],
});

/** A dynamic agreement: hourly prices from `from` (ms), `hours` long, `cents(i)`. */
export function dynamicAgreement({ id = '333', start, hours = 24, cents = (i) => 20 + i } = {}) {
  const forecast = [];
  for (let i = 0; i < hours; i += 1) {
    forecast.push({
      validFrom: new Date(start + i * 3600_000).toISOString(),
      validTo: new Date(start + (i + 1) * 3600_000).toISOString(),
      unitRateInformation: {
        __typename: 'SimpleProductUnitRateInformation',
        latestGrossUnitRateCentsPerKwh: String(cents(i)),
      },
    });
  }
  return {
    id,
    validFrom: '2026-01-01T00:00:00+01:00',
    validTo: null,
    isRevoked: false,
    product: { code: 'DYNAMIC-DE', fullName: 'Octopus Dynamic', isTimeOfUse: true },
    unitRateInformation: { __typename: 'SimpleProductUnitRateInformation', ...rate(30) },
    unitRateForecast: forecast,
  };
}

export const account = ({
  agreements = [simpleAgreement()],
  malo = MALO,
  smart = true,
  malos,
} = {}) =>
  ok({
    account: {
      allProperties: [
        {
          id: PROPERTY_ID,
          electricityMalos: malos ?? [
            {
              maloNumber: malo,
              meters: [
                { id: '1', shouldReceiveSmartMeterData: smart, hasSmartMeterGateway: smart },
              ],
              agreements,
            },
          ],
        },
      ],
    },
  });

export const standingCharges = (byAgreement = { 111: '14.90', 222: '12.50', 333: '10.00' }) =>
  ok({
    account: {
      allProperties: [
        {
          electricityMalos: [
            {
              maloNumber: MALO,
              agreements: Object.entries(byAgreement).map(([id, amount]) => ({
                id,
                standingChargeGrossRateInformation: [
                  { date: '2026-01-01', grossRate: amount, rateValidToDate: null },
                ],
              })),
            },
          ],
        },
      ],
    },
  });

export const devices = (list = []) => ok({ devices: list });

/** Quarters from `from` to `to` (ms), `kwh(t)`; `extra(t)` overrides a node. */
export function measurements({ from, to, kwh = () => 0.1, extra = () => ({}), next } = {}) {
  const edges = [];
  for (let t = from; t < to; t += 900_000) {
    edges.push({
      node: {
        value: String(kwh(t)),
        unit: 'kWh',
        startAt: new Date(t).toISOString(),
        endAt: new Date(t + 900_000).toISOString(),
        durationInSeconds: 900,
        metaData: {
          utilityFilters: { marketSupplyPointId: MALO, readingDirection: 'CONSUMPTION' },
        },
        ...extra(t),
      },
    });
  }
  return ok({
    property: {
      measurements: { pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null }, edges },
    },
  });
}

export const dispatches = (list = []) =>
  ok({
    flexPlannedDispatches: list.map(([start, end]) => ({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      type: 'SMART',
    })),
  });
