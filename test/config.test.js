import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsOf, normalizeConfig } from '../src/config.js';

test('the form: what is needed to log in, nothing sent otherwise', () => {
  const ok = normalizeConfig({
    email: ' kunde@example.com ',
    password: ' pass word ',
    account_number: 'a-1b2c3d4e',
  });
  assert.equal(ok.problem, undefined);
  assert.equal(ok.email, 'kunde@example.com');
  assert.equal(ok.password, ' pass word ', 'the password as typed');
  assert.equal(ok.accountNumber, 'A-1B2C3D4E');
  assert.deepEqual(credentialsOf(ok), { email: 'kunde@example.com', password: ' pass word ' });
  assert.equal(normalizeConfig({}).problem, 'missing');
  assert.equal(normalizeConfig(undefined).problem, 'missing');
  assert.equal(
    normalizeConfig({ password: 'x' }).problem,
    'half',
    'a password without its user is refused',
  );
  assert.equal(normalizeConfig({ email: 'kunde@example.com' }).problem, 'half');
  assert.equal(normalizeConfig({ email: 'kunde', password: 'x' }).problem, 'badEmail');
  assert.equal(normalizeConfig({ email: 'a@b.de\r\nX: 1', password: 'x' }).problem, 'malformed');
  assert.equal(normalizeConfig({ email: 'a@b.de', password: 'x\ny' }).problem, 'malformed');
  assert.equal(
    normalizeConfig({ email: 'a@b.de', password: 'x'.repeat(257) }).problem,
    'malformed',
  );
  assert.equal(normalizeConfig({ email: 'a@b.de', password: 42 }).problem, 'malformed');
  assert.equal(
    normalizeConfig({ email: 'a@b.de', password: 'x', account_number: '12345' }).problem,
    'badAccount',
  );
  const key = normalizeConfig({ api_key: 'sk_live_ABCDEFGHIJ' });
  assert.equal(key.problem, undefined);
  assert.deepEqual(credentialsOf(key), { apiKey: 'sk_live_ABCDEFGHIJ' });
  assert.equal(normalizeConfig({ api_key: 'sk live' }).problem, 'malformed');
});
