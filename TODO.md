# TODO

## Before announcing

- [ ] Test on a real Gladys 5.3+ with a real Octopus Germany account: login,
      Discovery, the 7-day consumption backfill, the price features over a
      day, a contract priced (fixed, Go, dynamic), the Intelligent device.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store fields left out of the manifest on purpose (Louis' rule): keywords
      `octopus`, `kraken`, `dynamischer Stromtarif`, `Intelligent Octopus Go`.
      The countries are declared (`DE`).

## To confirm on a real account (built without one)

- [ ] The login by e-mail and password still works: Kraken marked the
      `email`/`password` inputs of `obtainKrakenToken` deprecated on
      2026-03-18 ("scheduled for removal on or after 2026-09-21");
      octopus_germany still used them on 2026-11-07. If they are gone, the
      API key path stays (an Octopus Germany customer may have to ask for a
      key) and the login error code has to be checked.
- [ ] The refusal codes: KT-CT-1138 (from other Kraken suppliers),
      KT-CT-1134 / 1135 ("Invalid data", in the schema); KT-CT-1136 was seen
      with valid credentials during several days (octopus_germany issue 116)
      and is taken as a temporary block.
- [ ] `validFrom` / `validTo` of the agreements and the forecast: with an
      offset (parsed exactly), or without (read as German local time).
- [ ] `grossRateInformation` dates (`date`, `rateValidToDate`): local dates,
      `rateValidToDate` exclusive (as the schema says).
- [ ] The dynamic forecast (`unitRateForecast`): 15-minute or 1-hour slots,
      and how far back it goes (the past is priced from the prices kept).
- [ ] `standingChargeGrossRateInformation.grossRate` in EUR per month (as
      octopus_germany reads it).
- [ ] The measurements (`RAW_INTERVAL`): 15-minute nodes in kWh, the MaLo in
      `marketSupplyPointId`, pages of 100.
- [ ] `devices(accountNumber)` on an account without Intelligent device
      (an error or an empty list: both are handled), and
      `flexPlannedDispatches` with the Kraken device id.

## Decisions

- **Version 0.1.0** set by hand (package, lock, manifest, image tag) when
  leaving the template; the Release workflow owns it from now on.
- **`gladys_version: ">=5.3.0"`**: the catalog `countries` arrived in Gladys
  5.3.0; `publishEnergyConsumption` (POST /energy/consumption) and the energy
  contracts in 5.2.0, as for gladys-octopus-energy.
- **Read-only (v1)**: no smart-charge control, no boost, no meter reading
  submitted, no preference changed. The only mutation is the login.
- **One delegated template, no calendar.** The price of a customer depends on
  their own agreement (product, grid area, dates): no shared calendar key
  could carry it (calendar keys are global and provider-neutral), and the
  rule engine would need the forecast anyway. The fixed standing charge is a
  `fixed` component fed by a template input (Gladys computes it). The §14a
  module 3 variable grid fee is not included (documented).
- **Prices**: gross, VAT included, cents / 100. A half hour is priced at the
  mean of its two quarters (the core sends 30-minute intervals); a negative
  price costs 0; an unknown price fails the request (never a silent zero).
  A dynamic agreement is priced from its forecast only, never from its fixed
  rate. The prices seen (yesterday to the end of the forecast, at every
  account read) are kept 40 days in `/data`: the contract should start on the
  day of the installation (documented).
- **External ids**: `malo:<16 hex of an HMAC-SHA-256 of the MaLo>` and
  `flex:<same of the Kraken device id>`, under a random 32-byte key made at
  the first start and stored with `setConfig` as `id_key` (outside the form:
  never shown, kept by Gladys, never in `/data`). Without it, neither /data
  nor a device id gives a MaLo back (an unkeyed hash of an 11-digit number
  did, in seconds: review r1). Nothing is read nor published until the key is
  stored. The MaLo, not the meter: a replaced meter keeps its device.
- **Refusal**: only the login's KT-CT-1138/1134/1135 (and 11334, API access);
  persisted as 8 bits of a salted hash; no request until the credentials
  change in the form or Test succeeds. A 401/403 of a query, an expired token
  (one new login, one new try), KT-CT-1111 are passing errors. KT-CT-1136 is
  a pause (1 h doubled), never a refusal.
- **Token** in memory only; renewed 5 minutes before its end (from the
  payload's `exp - iat`, the server's own clock) with the refresh token,
  then with the credentials.
- **Pace**: account hourly; consumption every 3 h (3 days; 7 days daily
  after 06:00 and for a new device, at least 1 minute after another read);
  planned charges every 15 min for the created Intelligent devices only; 2 s
  between requests, one in flight. 429/1199: Retry-After or 15 min, 5xx:
  5 min, doubled to 6 h, persisted.
- **Contract MaLo**: the template input is the last 1-4 characters of the
  MaLo, among every MaLo seen (this read and the 8 kept in /data); empty is
  accepted with a single MaLo only; empty or ambiguous with several is
  refused (the contract stays unpriced), never guessed.
- **Partial answers**: an account answer carrying `errors` (KT-CT-3956 on
  the forecast…) is a passing error: nothing taken from it. A dynamic
  agreement (forecast sent, product named so, or seen dynamic once: keyed id
  in /data) is priced from its forecast only. A price kept for a quarter
  already started is never rewritten; the prices leave /data by age (40
  days) or with their MaLo (8 MaLos kept, the least recently seen out).
- **API key first**: recommended in the form and the docs; e-mail and
  password stay as a fallback. A login refused by the schema (a validation
  error naming a removed field) or KT-CT-1113 is `login_gone`: a pause of
  1 h doubled to 6 h with a status asking for an API key, lifted by new
  credentials, never a refusal.
- **Email** is a plain `string` field (the user sees which login is set);
  the password and the API key are `secret`.
- **Reused project**: octopus_germany (MIT) for the queries and the reading of
  the answers, rewritten in JavaScript (no maintained JS client exists).

## Ideas

- Price the past of a dynamic tariff from `agreementRates(agreementId,
activeAt)` (in the schema) instead of the prices kept, once checked on a
  real account: a Gladys stopped more than a day would no longer leave
  quarters without a price.

- Gas (`gasMalos`) once the core prices gas contracts.
- Export (feed-in) meters: `energy-production-sensor`.
- The §14a module 3 grid fee in the price, if Octopus exposes it per account
  (octopus_germany reads it from a second backend).
- Write actions (smart charge, boost) behind options, disabled by default,
  never a switch.
