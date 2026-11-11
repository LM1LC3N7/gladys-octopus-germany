# Octopus Energy Germany for Gladys Assistant

Unofficial integration, not affiliated with Octopus Energy. It reads your
**Octopus Energy Germany** customer account through the official Kraken API
of Octopus Germany (`api.oeg-kraken.energy`, documented on
developer.oeg-kraken.energy) and gives Gladys:

- one device per **electricity market location (MaLo)** of the account, with
  the price per kWh now, the next price, the monthly standing charge and, for
  a smart meter (iMSys), the consumption by half hour for the energy
  monitoring;
- one device per **Intelligent Octopus device** (car, charge point) with
  "Smart charge planned now";
- an energy contract template, **Octopus Energy Germany electricity**, priced
  from the tariff of your account: fixed, time-of-use (Intelligent Octopus
  Go, Heat…) or dynamic.

**Read-only.** The only request that is not a read is the login. Nothing is
ever changed on your account, your meters or your devices (no smart charge,
no boost, no meter reading sent).

> This integration has never been tested with a real Octopus Germany account:
> it was written from the published API schema and from the queries of
> octopus_germany (Home Assistant, MIT). Please report what you see.

## Setup

1. Enter the **e-mail address** and the **password** of your Octopus account
   (the ones of the Octopus website and app). The password is kept by Gladys
   in its database, never shown again, and sent only to Octopus Germany to
   log in. The integration keeps the Kraken token in memory only.
2. If Octopus gave you an **API key** for your account (`sk_live_…`), you may
   enter it instead: it is used alone.
3. With several accounts on one login, enter the **account number** to read
   (empty: the first one; the status says so).
4. Press **Test the connection** (at most once a minute): it logs in and
   counts your accounts.
5. In **Discovery**, add the devices you want. Nothing is asked of Octopus
   for a device nobody added (consumption, planned charges).
6. In the energy settings of Gladys, create a contract from the template
   **Octopus Energy Germany electricity** on your meter: enter the last 4
   digits of the MaLo (shown in the device name; empty: the first one) and
   your monthly standing charge (shown by the "Standing charge per month"
   feature, VAT included).

## Devices

| Device                           | Feature                   | Meaning                                         |
| -------------------------------- | ------------------------- | ----------------------------------------------- |
| Octopus electricity (MaLo …1234) | Price per kWh now         | gross price (VAT included), EUR/kWh             |
|                                  | Next price per kWh        | the next different price within 2 days          |
|                                  | Standing charge per month | gross, EUR, from your agreement                 |
|                                  | Consumption (30 min)      | smart meter (iMSys) only, kWh, dated by Octopus |
| Octopus Intelligent …            | Smart charge planned now  | 1 inside a planned charge, 0 outside            |

The **device id** is a hash of the MaLo number (16 hex digits): the MaLo
number itself never appears in an id, a log, the status or `/data`; the
device name shows its last 4 digits. The MaLo, not the meter, is the
identity: a replaced meter keeps its Gladys device and its history.

A value Octopus does not give stays unknown: nothing is ever published as 0
in its place. The prices are published again at every quarter of an hour
from what was read; a tariff read more than 6 hours ago is not published as
current any more.

## Pace

- the account (tariffs, dynamic prices ahead, devices): every hour;
- the consumption of the added meters: every 3 hours, the last 3 days; 7
  days for a new device and once a day after 06:00 (German time);
- the planned charges of the added Intelligent devices: every 15 minutes.

Each time is kept in `/data` before the request: a restart, a reconnection or
Discovery never bring a read forward, and the test button only logs in and
lists the accounts (at most once a minute). Two exceptions, a minute after
the previous read at the earliest: another login or account number saved in
the form (the account), a meter device just added (its consumption). The
requests go one at a time, 2 seconds apart.

## The energy contract

The template is **priced by the integration** (delegated): Gladys sends the
consumption by half hour, the integration answers its cost:

- the price of a half hour is the mean of its two quarters of an hour, VAT
  included, from the agreement in force then (a change of tariff mid-month is
  priced right);
- **dynamic tariff**: the price of the Octopus forecast for that quarter,
  nothing else; **time-of-use** (Intelligent Octopus Go: 00:00 to 05:00 German
  time): the rate of the time slot, the changes of time included;
  **fixed**: the rate, within the dates Octopus gives it;
- a negative price costs 0 (Gladys does not take credits);
- an unknown price is never a 0: the half hour is left without a cost and
  Gladys asks again later.

The dynamic prices are only known ahead of time: the integration keeps every
price it has seen in `/data` for 40 days, so that it can price the past.
**Start the contract on the day the integration was installed** (or later): a
half hour before that has no known dynamic price and would stay unpriced.

Not included: a variable §14a grid fee (module 3), which Octopus bills on top
for the customers who chose it. The standing charge is the amount you enter
in the contract (Gladys computes it, not the integration).

## Status and errors

| Status                                               | Meaning                                              | What happens                                              |
| ---------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Octopus refused the login (KT-CT-1138, 1134 or 1135) | wrong e-mail or password                             | no request until you change them or Test succeeds         |
| API access is not enabled (KT-CT-11334)              | Octopus disabled API access for this user            | same                                                      |
| Octopus blocks the login for now (KT-CT-1136)        | a temporary block, seen with valid credentials       | pause of 1 hour, doubled up to 6 hours                    |
| Octopus asked to slow down                           | HTTP 429 or KT-CT-1199                               | pause of Retry-After or 15 minutes, doubled up to 6 hours |
| Octopus is having trouble                            | HTTP 5xx or KT-CT-7899                               | pause of 5 minutes, doubled up to 6 hours                 |
| Octopus could not be read                            | network, timeout, unreadable answer, a query refused | tried again after 5, 10, 20, 40 then every 60 minutes     |

A 401 or 403 answered to a query (not to the login) is never taken as a
refused password: one new login, then a passing error. The pauses and the
refusal are kept in `/data` (the refusal as 8 bits of a salted hash of the
credentials, never the credentials).

**Octopus' new sign-in.** Octopus marked the login by e-mail and password of
its API as deprecated in 2026. If the website accepts your password but the
integration says it is refused, your account may use the new sign-in: an API
key of the account still works (ask Octopus for one).

## What `/data` holds

`/data/octopus-germany.json`: the time of the last reads, the pause, the
refusal (8 bits of a salted hash), the MaLos seen (hash, last 4 digits,
tariff name, smart meter or not) and the prices of the last 40 days. Never
the e-mail address, the password, a token, the account number nor a whole
MaLo number.

## Limits

- Electricity only: gas, feed-in (export) and the balance of the account are
  not read.
- The planned charges of Intelligent Octopus do not change the price
  computed here: the tariff time slots do.
- Never tested with a real account (see above): the answers are read
  strictly, and an answer of an unexpected shape is a passing error, never a
  wrong value.

## Credits

The GraphQL queries are adapted from octopus_germany by thecem (MIT,
github.com/thecem/octopus_germany), as is the reading of the tariffs and of
the measurements, rewritten in JavaScript. Notice in `THIRD_PARTY_NOTICES.md`.
