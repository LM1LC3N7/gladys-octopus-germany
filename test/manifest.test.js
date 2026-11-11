// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. No version is
// pinned: only its shape and its agreement across files.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, TEMPLATES } from '../src/constants.js';
import { buildFlexDevice, buildMaloDevice } from '../src/devices.js';
import { ALL_TEXTS } from '../src/i18n.js';

const CORE = '/home/claude/code/Gladys/server';
const normalizeSupportedOptions = existsSync(`${CORE}/utils/normalizeSupportedOptions.js`)
  ? createRequire(import.meta.url)(`${CORE}/utils/normalizeSupportedOptions.js`)
      .normalizeSupportedOptions
  : undefined;
// The units the core accepts per category (its constants when the clone is
// here, the ones this integration uses otherwise).
const UNITS = existsSync(`${CORE}/utils/constants.js`)
  ? createRequire(import.meta.url)(`${CORE}/utils/constants.js`).DEVICE_FEATURE_UNITS_BY_CATEGORY
  : { currency: ['euro'], 'energy-sensor': ['kilowatt-hour'] };

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const field = (key) => manifest.config_schema.find((f) => f.key === key);

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, the version agreeing everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  // publishEnergyConsumption and the energy contracts arrived with Gladys 5.2.0.
  assert.equal(manifest.gladys_version, '>=5.2.0');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-octopus-germany');
  assert.equal(lock.name, pkg.name);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-octopus-germany:${manifest.version}`,
  );
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-octopus-germany\//,
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300);
    assert.match(
      docs,
      /never been tested with a real Octopus|jamais été testée avec un vrai compte Octopus/,
    );
    assert.match(docs, /octopus_germany/);
  }
});

test('every text is in English and French; sections within their limits', () => {
  for (const [path, entry] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(entry[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr'])
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('no key starts with gladys_; secrets have no default; nothing said encrypted', () => {
  const all = [...manifest.config_schema, ...manifest.actions.flatMap((a) => a.fields ?? [])];
  for (const f of all) assert.doesNotMatch(f.key, /^gladys_/);
  const secrets = manifest.config_schema.filter((f) => f.type === 'secret');
  assert.deepEqual(
    secrets.map((f) => f.key),
    ['api_key', 'password'],
  );
  for (const f of secrets) {
    assert.equal(f.default, undefined);
    assert.match(
      f.description.en,
      /Kept by Gladys in its database, never shown again, sent only to Octopus Energy Germany/,
    );
    assert.match(f.description.fr, /Gard(é|ée) par Gladys dans sa base, jamais réaffiché/);
  }
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'src/i18n.js',
  ]) {
    // "chiffres" (digits) is fine; "chiffré" (encrypted) never.
    assert.doesNotMatch(read(file), /chiffr(é|ement)|encrypt|hachage/i, file);
  }
});

test('the config fields are the ones the code reads', () => {
  assert.deepEqual(
    manifest.config_schema.filter((f) => f.type !== 'section').map((f) => f.key),
    ['api_key', 'email', 'password', 'account_number'],
  );
  assert.equal(field('email').type, 'string');
  const config = read('src/config.js');
  for (const f of manifest.config_schema.filter((x) => x.type !== 'section')) {
    assert.ok(config.includes(`.${f.key}`), f.key);
  }
});

test('the action and the contract template are the ones the code handles', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  for (const a of manifest.actions) assert.ok(a.timeout_seconds >= 5 && a.timeout_seconds <= 120);
  // Read-only: no command handler at all.
  assert.ok(!handlers.includes('onSetValue'));
  assert.ok(handlers.includes('onEnergyPrice') && handlers.includes('onEnergyCurrent'));
  const { templates, calendars } = manifest.energy_contracts;
  assert.equal(calendars, undefined);
  assert.deepEqual(
    templates.map((x) => x.key),
    Object.values(TEMPLATES),
  );
  const [tpl] = templates;
  assert.match(tpl.key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(tpl.country, 'DE');
  assert.equal(tpl.currency, 'EUR');
  assert.equal(tpl.timezone, 'Europe/Berlin');
  assert.equal(tpl.pricing_mode, 'delegated');
  // Delegated: only `fixed` components; every placeholder has its input.
  for (const c of tpl.tariff.components) assert.equal(c.kind, 'fixed');
  const inputs = tpl.inputs.map((i) => i.key);
  for (const [, key] of JSON.stringify(tpl.tariff).matchAll(/\{\{input:(\w+)\}\}/g))
    assert.ok(inputs.includes(key), key);
  for (const i of tpl.inputs) assert.notEqual(i.type, 'secret');
  assert.deepEqual(inputs, ['malo_suffix', 'standing_charge']);
  assert.ok(read('src/app.js').includes('inputs?.malo_suffix'));
});

test('the devices: units of the core only, every feature read-only, no switch', () => {
  const gladys = createFakeGladys({ selector: 'octopus-germany' });
  const devices = [
    buildMaloDevice(gladys, { key: '0123456789abcdef', suffix: '5678', smart: true, tariff: 'Go' }),
    buildFlexDevice(gladys, { key: '0123456789abcdef', name: 'Wallbox', type: 'CHARGE_POINTS' }),
  ];
  for (const device of devices) {
    for (const f of device.features) {
      assert.equal(f.read_only, true);
      assert.notEqual(f.category, 'switch');
      if (f.unit) assert.ok(UNITS[f.category].includes(f.unit), f.external_id);
      const options = f.supported_options ?? [];
      for (const o of options) {
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.trim() === o.label && o.label.length > 0);
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
      }
      assert.equal(new Set(options.map((o) => o.value)).size, options.length);
      if (normalizeSupportedOptions && options.length) {
        assert.deepEqual(normalizeSupportedOptions(options), options);
      }
    }
  }
  // The only binary is a sensor of a planned charge, never a command.
  const binaries = devices.flatMap((d) => d.features).filter((f) => f.type === 'binary');
  assert.deepEqual(
    binaries.map((f) => [f.category, f.external_id.split(':').at(-1)]),
    [['unknown', 'dispatching']],
  );
});

test('every runtime text exists in both languages', () => {
  for (const [key, entry] of Object.entries(ALL_TEXTS)) {
    assert.deepEqual(Object.keys(entry).sort(), ['en', 'fr'], key);
    for (const lang of ['en', 'fr']) assert.ok(entry[lang].trim(), `${key}.${lang}`);
    const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(entry.fr), names(entry.en), key);
  }
});
