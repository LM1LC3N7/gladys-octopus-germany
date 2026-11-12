# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Declared for Germany only (`countries: ["DE"]`): the Gladys catalog of an
  instance located elsewhere no longer lists it in its browse views (the
  search still finds it). Requires Gladys 5.3.0 or later.

## [0.1.1] - 2026-11-11

### Added

- First version: the Octopus Energy Germany account read through the official
  Kraken GraphQL API (e-mail and password, or an API key of the account),
  read-only.
- One device per electricity market location (MaLo): price per kWh now and
  next, monthly standing charge, smart-meter consumption by half hour
  (`publishEnergyConsumption`).
- One device per Intelligent Octopus device: smart charge planned now.
- The delegated energy contract template "Octopus Energy Germany electricity"
  (fixed, time-of-use and dynamic tariffs), with the prices seen kept 40 days
  to price the past.
- Refused login, pauses (429, 5xx, KT-CT-1136) and the pace kept in `/data`;
  the test button.
- The API key is the recommended login; the e-mail and password login, which
  Kraken deprecated, says clearly when Octopus no longer accepts it.
- Device ids are an HMAC of the MaLo under a key kept in the Gladys config.

[Unreleased]: https://github.com/LM1LC3N7/gladys-octopus-germany/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-octopus-germany/releases/tag/v0.1.1
