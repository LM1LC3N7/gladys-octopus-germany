# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Octopus Germany account: login,
      Discovery, the 7-day consumption backfill, the price features over a
      day, a contract priced (fixed, Go, dynamic), the Intelligent device.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store fields left out of the manifest on purpose (Louis' rule):
      `countries: ["DE"]`, keywords `octopus`, `kraken`,
      `dynamischer Stromtarif`, `Intelligent Octopus Go`.

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
      `rateValidToDate` taken as the last day of the rate.
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
- **`gladys_version: ">=5.2.0"`**, not 5.1.0: `publishEnergyConsumption`
  (POST /energy/consumption) and the energy contracts arrived in Gladys
  5.2.0, as for gladys-octopus-energy.
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
- **External ids**: `malo:<16 hex of a SHA-256 of the MaLo>` and
  `flex:<16 hex of the Kraken device id>`: the MaLo number never leaves
  memory (not in ids, logs, status, `/data`); the device name shows its last
  4 digits. The MaLo, not the meter: a replaced meter keeps its device.
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
  MaLo; empty takes the first MaLo (sorted by key); a suffix matching two
  MaLos is refused (the contract stays unpriced), never guessed.
- **Email** is a plain `string` field (the user sees which login is set);
  the password and the API key are `secret`.
- **Reused project**: octopus_germany (MIT) for the queries and the reading of
  the answers, rewritten in JavaScript (no maintained JS client exists).

## Ideas

- Gas (`gasMalos`) once the core prices gas contracts.
- Export (feed-in) meters: `energy-production-sensor`.
- The §14a module 3 grid fee in the price, if Octopus exposes it per account
  (octopus_germany reads it from a second backend).
- Write actions (smart charge, boost) behind options, disabled by default,
  never a switch.
