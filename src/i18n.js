// -----------------------------------------------------------------------------
// Runtime texts, English and French: device and feature names, the status of
// the configuration screen, the answers of the test button.
// -----------------------------------------------------------------------------

const TEXTS = {
  deviceMalo: {
    en: 'Octopus electricity (MaLo …{suffix})',
    fr: 'Octopus électricité (MaLo …{suffix})',
  },
  deviceFlex: { en: 'Octopus Intelligent {name}', fr: 'Octopus Intelligent {name}' },
  featurePrice: { en: 'Price per kWh now', fr: 'Prix du kWh actuel' },
  featureNextPrice: { en: 'Next price per kWh', fr: 'Prochain prix du kWh' },
  featureStandingCharge: { en: 'Standing charge per month', fr: 'Abonnement par mois' },
  featureConsumption: { en: 'Consumption (30 min)', fr: 'Consommation (30 min)' },
  featureDispatching: { en: 'Smart charge planned now', fr: 'Recharge pilotée prévue maintenant' },

  // Status of the configuration screen.
  missing: {
    en: 'Enter an API key of your Octopus Energy Germany account (or its e-mail address and password).',
    fr: 'Saisissez une clé d’API de votre compte Octopus Energy Allemagne (ou son adresse e-mail et son mot de passe).',
  },
  half: {
    en: 'Both the e-mail address and the password are needed: nothing is sent with only one.',
    fr: 'L’adresse e-mail et le mot de passe sont nécessaires tous les deux : rien n’est envoyé avec un seul.',
  },
  malformed: {
    en: 'A field holds a control character or is too long: nothing is sent.',
    fr: 'Un champ contient un caractère de contrôle ou est trop long : rien n’est envoyé.',
  },
  badEmail: {
    en: 'The e-mail address does not look like one: nothing is sent.',
    fr: 'L’adresse e-mail n’en a pas la forme : rien n’est envoyé.',
  },
  badAccount: {
    en: 'The account number looks like A-1B2C3D4E: nothing is sent until it is fixed or emptied.',
    fr: 'Le numéro de compte a la forme A-1B2C3D4E : rien n’est envoyé tant qu’il n’est pas corrigé ou vidé.',
  },
  refused: {
    en: 'Octopus refused the login ({code}). Check the API key, or the e-mail address and the password, then press Test. If the password works on the Octopus website, your account may use the new Octopus sign-in: enter an API key of the account (see the guide).',
    fr: 'Octopus a refusé la connexion ({code}). Vérifiez la clé d’API, ou l’adresse e-mail et le mot de passe, puis appuyez sur Tester. Si le mot de passe fonctionne sur le site d’Octopus, votre compte utilise peut-être la nouvelle connexion d’Octopus : saisissez une clé d’API du compte (voir le guide).',
  },
  apiAccess: {
    en: 'Octopus says API access is not enabled for this account user (KT-CT-11334). Ask Octopus to enable it, then press Test.',
    fr: 'Octopus indique que l’accès à l’API n’est pas activé pour cet utilisateur (KT-CT-11334). Demandez à Octopus de l’activer, puis appuyez sur Tester.',
  },
  idKeyNotStored: {
    en: 'Gladys could not store the key of the device ids of this integration: nothing is read until it is stored. Next try at {time}.',
    fr: 'Gladys n’a pas pu enregistrer la clé des identifiants d’appareils de cette intégration : rien n’est lu tant qu’elle ne l’est pas. Nouvel essai à {time}.',
  },
  loginGone: {
    en: 'Octopus no longer accepts the login by e-mail address and password: enter an API key of your account (see the guide). Next try at {time}.',
    fr: 'Octopus n’accepte plus la connexion par adresse e-mail et mot de passe : saisissez une clé d’API de votre compte (voir le guide). Nouvel essai à {time}.',
  },
  loginBlocked: {
    en: 'Octopus blocks the login for now (KT-CT-1136), with valid credentials too: next try at {time}.',
    fr: 'Octopus bloque la connexion pour le moment (KT-CT-1136), même avec des identifiants valides : nouvel essai à {time}.',
  },
  rateLimited: {
    en: 'Octopus asked to slow down: next request at {time}.',
    fr: 'Octopus a demandé de ralentir : prochaine requête à {time}.',
  },
  server: {
    en: 'Octopus is having trouble ({code}): next request at {time}.',
    fr: 'Octopus a un problème ({code}) : prochaine requête à {time}.',
  },
  noAccount: {
    en: 'Logged in, but this login has no Octopus account.',
    fr: 'Connecté, mais cette connexion n’a aucun compte Octopus.',
  },
  unknownAccount: {
    en: 'Logged in, but the account number entered is not one of this login: fix it or empty it.',
    fr: 'Connecté, mais le numéro de compte saisi n’est pas l’un de cette connexion : corrigez-le ou videz-le.',
  },
  noMalo: {
    en: 'Logged in: the account has no electricity market location (MaLo) yet.',
    fr: 'Connecté : le compte n’a pas encore de point de livraison d’électricité (MaLo).',
  },
  starting: {
    en: 'Starting: first read at {time}.',
    fr: 'Démarrage : première lecture à {time}.',
  },
  failing: {
    en: 'Octopus could not be read ({code}): next try at {time}.',
    fr: 'Octopus n’a pas pu être lu ({code}) : nouvel essai à {time}.',
  },
  connected: {
    en: 'Connected: {count} electricity market location(s), tariff read at {time}.',
    fr: 'Connecté : {count} point(s) de livraison d’électricité, tarif lu à {time}.',
  },
  lastFailed: {
    en: ' The last read failed ({code}): next try at {time}.',
    fr: ' La dernière lecture a échoué ({code}) : nouvel essai à {time}.',
  },
  consumptionFailed: {
    en: ' The consumption could not be read ({code}).',
    fr: ' La consommation n’a pas pu être lue ({code}).',
  },
  severalAccounts: {
    en: ' This login has several accounts: the first one is read, enter its number to choose.',
    fr: ' Cette connexion a plusieurs comptes : le premier est lu, saisissez son numéro pour choisir.',
  },
  storage: {
    en: ' /data cannot be read: the pace and the price history are not kept.',
    fr: ' /data est illisible : le rythme et l’historique des prix ne sont pas gardés.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: next try soon.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai bientôt.',
  },

  // Test button.
  testOk: {
    en: 'Login accepted: {count} account(s) found.',
    fr: 'Connexion acceptée : {count} compte(s) trouvé(s).',
  },
  testTooSoon: {
    en: 'Tested less than a minute ago: try again in a moment.',
    fr: 'Testé il y a moins d’une minute : réessayez dans un instant.',
  },
  testPaused: {
    en: 'Not sent: Octopus asked to wait until {time}.',
    fr: 'Rien envoyé : Octopus a demandé d’attendre jusqu’à {time}.',
  },
  testFailed: {
    en: 'Octopus could not be reached ({code}): nothing changed.',
    fr: 'Octopus n’a pas pu être joint ({code}) : rien n’a changé.',
  },
};

/** A text in a language, with its {placeholders} filled. */
export function t(key, language = 'en', values = {}) {
  const entry = TEXTS[key];
  const text = entry?.[language] ?? entry?.en ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

/** Both languages of a text: { en, fr }. */
export const both = (key, values) => ({ en: t(key, 'en', values), fr: t(key, 'fr', values) });

export const ALL_TEXTS = TEXTS;
