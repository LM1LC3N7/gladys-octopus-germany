# Octopus Energy Germany for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**Octopus Energy Germany** customers, not affiliated with Octopus Energy. It
reads your account through the official Kraken GraphQL API of Octopus
Germany (`api.oeg-kraken.energy`) with an API key of your account
(recommended) or, as a fallback, your e-mail address and password:

- one device per electricity market location (MaLo): price per kWh now and
  next, monthly standing charge, smart-meter (iMSys) consumption by half hour
  for the energy monitoring;
- one device per Intelligent Octopus device: "Smart charge planned now";
- the energy contract template **Octopus Energy Germany electricity**, priced
  by the integration from your tariff: fixed, time-of-use (Intelligent
  Octopus Go, Heat) or dynamic.

**Read-only**: the only mutation ever sent is the login. Never tested with a
real Octopus Germany account yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run mutants     # mutation check of the guards (scripts/mutants.json)
npm run cover       # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).
Open points and decisions: [TODO.md](TODO.md).

## Credits and license

Apache-2.0 ([LICENSE](LICENSE)). The GraphQL queries are adapted from
[octopus_germany](https://github.com/thecem/octopus_germany) (MIT): see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
