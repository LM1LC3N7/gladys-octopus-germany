// -----------------------------------------------------------------------------
// The configuration of the form, normalized: the e-mail address and the
// password of the Octopus Energy Germany customer account (or an API key of
// the account), and the account number when the login has several. Nothing
// here talks to the network.
// -----------------------------------------------------------------------------

/** Control characters (CR, LF, tab included): never in a credential nor an id. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const text = (value, max) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= max && !CONTROL.test(trimmed) ? trimmed : undefined;
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const ACCOUNT = /^[A-Z]-[A-Z0-9]{4,16}$/;
const API_KEY = /^[\x21-\x7e]{8,200}$/;

/**
 * `{ email, password, apiKey, accountNumber, problem }`: `problem` names what
 * keeps the integration from logging in (nothing is sent then).
 */
export function normalizeConfig(raw = {}) {
  const email = text(raw?.email, 254);
  // A password is taken as typed (spaces included), only bounded and without control characters.
  const password =
    raw?.password === undefined || raw?.password === null
      ? ''
      : typeof raw.password === 'string' &&
          raw.password.length <= 256 &&
          !CONTROL.test(raw.password)
        ? raw.password
        : undefined;
  const apiKey = text(raw?.api_key, 200);
  const account = text(raw?.account_number, 40);
  const config = {
    email: email ?? '',
    password: password ?? '',
    apiKey: apiKey ?? '',
    accountNumber: (account ?? '').toUpperCase(),
    problem: undefined,
  };
  if (email === undefined || password === undefined || apiKey === undefined) {
    config.problem = 'malformed';
  } else if (config.apiKey) {
    if (!API_KEY.test(config.apiKey)) config.problem = 'malformed';
  } else if (!config.email && !config.password) {
    config.problem = 'missing';
  } else if (!config.email || !config.password) {
    // A password without its e-mail address (or the reverse) is never sent.
    config.problem = 'half';
  } else if (!EMAIL.test(config.email)) {
    config.problem = 'badEmail';
  }
  if (!config.problem && account === undefined) config.problem = 'malformed';
  if (!config.problem && config.accountNumber && !ACCOUNT.test(config.accountNumber)) {
    config.problem = 'badAccount';
  }
  return config;
}

/** The credentials sent to the login: the API key alone when given. */
export const credentialsOf = (config) =>
  config.apiKey ? { apiKey: config.apiKey } : { email: config.email, password: config.password };
