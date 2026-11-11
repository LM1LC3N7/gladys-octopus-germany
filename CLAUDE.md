# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads **Octopus Energy Germany** through the official Kraken GraphQL API
(`api.oeg-kraken.energy/v1/graphql/`, login by `obtainKrakenToken` with the
customer's e-mail and password, or an API key): the electricity market
locations (MaLo), their agreements and unit rates (fixed, time-of-use,
dynamic forecast), the smart-meter quarters, the Intelligent devices and
their planned charges. **Read-only**: the login is the only mutation.
Unofficial: not affiliated with Octopus Energy. Sibling of
gladys-octopus-energy (Great Britain).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
node --test --test-name-pattern "Go"      # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run mutants                           # mutation check (scripts/mutants.json), use memcap
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers the handlers)
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        OctopusApp: pace, /data, account, consumption, planned
                                  charges, price features, delegated pricing, status, test
src/kraken/client.js              the only network access: POST GraphQL, login, token, errors
src/kraken/queries.js             the GraphQL documents (read-only, the login apart)
src/kraken/model.js               answers -> MaLos, agreements, prices, quarters (pure)
src/devices.js                    the devices, feature keys, states (pure)
src/time.js                       local time of Germany (Europe/Berlin), pure
src/config.js                     the form, normalized
src/store.js                      /data/octopus-germany.json
src/constants.js                  endpoint, pace, bounds, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: config, action, energy contract template
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys
scripts/                          cover.png generator, mutation runner and list
```

## Rules

- **Octopus keys are forever too**: the external ids `malo:<hash>` and
  `flex:<hash>` (16 hex of an HMAC-SHA-256 of the MaLo / Kraken device id
  under the `id_key` kept in the Gladys config outside the form, see
  `keyOf`; never an unkeyed hash, never the key in /data or a log), the `FEATURE` keys of `src/devices.js`, the template key
  `octopus-de-electricity` and its inputs `malo_suffix`, `standing_charge`.
- **Never the MaLo number, the e-mail, the password, a token or the account
  number** in a log, the status, an error message, an id or `/data`.
- **Read-only**: never add a mutation besides `obtainKrakenToken` without an
  option disabled by default (and never as a `switch`).
- **Be polite with Octopus**: account hourly, consumption every 3 h, planned
  charges every 15 min, one request at a time, 2 s apart; every time kept in
  /data before the request.

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
