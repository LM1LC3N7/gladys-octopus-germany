# Octopus Energy Allemagne pour Gladys Assistant

Intégration non officielle, sans lien avec Octopus Energy. Elle lit votre
compte client **Octopus Energy Allemagne** par l'API Kraken officielle
d'Octopus Allemagne (`api.oeg-kraken.energy`, documentée sur
developer.oeg-kraken.energy) et donne à Gladys :

- un appareil par **point de livraison d'électricité (MaLo)** du compte, avec
  le prix du kWh actuel, le prochain prix, l'abonnement mensuel et, pour un
  compteur communicant (iMSys), la consommation par demi-heure pour le suivi
  énergétique ;
- un appareil par **appareil Intelligent Octopus** (voiture, borne) avec
  « Smart charge planned now » (recharge pilotée prévue maintenant) ;
- un modèle de contrat d'énergie, **Octopus Energy Allemagne électricité**,
  tarifé depuis le tarif de votre compte : fixe, à plages horaires
  (Intelligent Octopus Go, Heat…) ou dynamique.

**Lecture seule.** La seule requête qui n'est pas une lecture est la
connexion. Rien n'est jamais modifié sur votre compte, vos compteurs ou vos
appareils (ni recharge pilotée, ni boost, ni relevé envoyé).

> Cette intégration n'a jamais été testée avec un vrai compte Octopus
> Allemagne : elle a été écrite d'après le schéma publié de l'API et les
> requêtes d'octopus_germany (Home Assistant, MIT). Dites-nous ce que vous
> voyez.

## Mise en route

1. Saisissez l'**adresse e-mail** et le **mot de passe** de votre compte
   Octopus (ceux du site et de l'app Octopus). Le mot de passe est gardé par
   Gladys dans sa base, jamais réaffiché, et envoyé seulement à Octopus
   Allemagne pour se connecter. L'intégration garde le jeton Kraken en
   mémoire seulement.
2. Si Octopus vous a donné une **clé d'API** pour votre compte (`sk_live_…`),
   vous pouvez la saisir à la place : elle est alors utilisée seule.
3. Avec plusieurs comptes sur une même connexion, saisissez le **numéro de
   compte** à lire (vide : le premier ; le statut le signale).
4. Appuyez sur **Tester la connexion** (au plus une fois par minute) : elle
   se connecte et compte vos comptes.
5. Dans **Découverte**, ajoutez les appareils voulus. Rien n'est demandé à
   Octopus pour un appareil que personne n'a ajouté (consommation, recharges
   prévues).
6. Dans les réglages énergie de Gladys, créez un contrat depuis le modèle
   **Octopus Energy Allemagne électricité** sur votre compteur : saisissez les
   4 derniers chiffres de la MaLo (visibles dans le nom de l'appareil ; vide :
   la première) et votre abonnement mensuel (affiché par la fonctionnalité
   « Standing charge per month », TVA incluse).

## Appareils

| Appareil                         | Fonctionnalité            | Sens                                                           |
| -------------------------------- | ------------------------- | -------------------------------------------------------------- |
| Octopus electricity (MaLo …1234) | Price per kWh now         | prix TTC du kWh, EUR/kWh                                       |
|                                  | Next price per kWh        | le prochain prix différent, sous 2 jours                       |
|                                  | Standing charge per month | abonnement TTC, EUR, de votre contrat                          |
|                                  | Consumption (30 min)      | compteur communicant (iMSys) seulement, kWh, datée par Octopus |
| Octopus Intelligent …            | Smart charge planned now  | 1 pendant une recharge prévue, 0 sinon                         |

L'**identifiant de l'appareil** est une empreinte du numéro de MaLo
(16 chiffres hexadécimaux) : le numéro de MaLo lui-même n'apparaît jamais
dans un identifiant, un journal, le statut ni `/data` ; le nom de l'appareil
en montre les 4 derniers chiffres. C'est la MaLo, pas le compteur, qui fait
l'identité : un compteur remplacé garde son appareil Gladys et son
historique.

Une valeur qu'Octopus ne donne pas reste inconnue : rien n'est jamais publié
comme 0 à sa place. Les prix sont republiés à chaque quart d'heure d'après ce
qui a été lu ; un tarif lu il y a plus de 6 heures n'est plus publié comme
actuel.

## Rythme

- le compte (tarifs, prix dynamiques à venir, appareils) : toutes les heures ;
- la consommation des compteurs ajoutés : toutes les 3 heures, les 3
  derniers jours ; 7 jours pour un nouvel appareil et une fois par jour après
  6 h (heure allemande) ;
- les recharges prévues des appareils Intelligent ajoutés : toutes les
  15 minutes.

Chaque heure est notée dans `/data` avant la requête : un redémarrage, une
reconnexion ou la Découverte n'avancent jamais une lecture, et le bouton de
test ne fait que se connecter et lister les comptes (au plus une fois par
minute). Deux exceptions, au plus tôt une minute après la lecture précédente :
une autre connexion ou un autre numéro de compte enregistrés dans le
formulaire (le compte), un appareil de compteur qui vient d'être ajouté (sa
consommation). Les requêtes partent une à la fois, à 2 secondes d'intervalle.

## Le contrat d'énergie

Le modèle est **tarifé par l'intégration** (délégué) : Gladys envoie la
consommation par demi-heure, l'intégration en répond le coût :

- le prix d'une demi-heure est la moyenne de ses deux quarts d'heure, TVA
  incluse, d'après le contrat en vigueur à ce moment (un changement de tarif
  en cours de mois est bien tarifé) ;
- **tarif dynamique** : le prix de la prévision d'Octopus pour ce quart
  d'heure, rien d'autre ; **à plages horaires** (Intelligent Octopus Go : de
  0 h à 5 h, heure allemande) : le prix de la plage, changements d'heure
  compris ; **fixe** : le prix, dans les dates qu'Octopus lui donne ;
- un prix négatif coûte 0 (Gladys ne prend pas de crédit) ;
- un prix inconnu n'est jamais un 0 : la demi-heure reste sans coût et
  Gladys redemande plus tard.

Les prix dynamiques ne sont connus qu'à l'avance : l'intégration garde dans
`/data` chaque prix vu pendant 40 jours, pour tarifer le passé. **Faites
commencer le contrat le jour de l'installation de l'intégration** (ou plus
tard) : une demi-heure antérieure n'a pas de prix dynamique connu et resterait
sans coût.

Non inclus : un tarif de réseau variable §14a (module 3), qu'Octopus facture
en plus aux clients qui l'ont choisi. L'abonnement est le montant saisi dans
le contrat (Gladys le calcule, pas l'intégration).

## Statut et erreurs

| Statut                                                   | Sens                                                     | Ce qui se passe                                                              |
| -------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Octopus a refusé la connexion (KT-CT-1138, 1134 ou 1135) | e-mail ou mot de passe faux                              | aucune requête tant que vous ne les changez pas ou que Tester ne réussit pas |
| L'accès à l'API n'est pas activé (KT-CT-11334)           | Octopus a désactivé l'accès à l'API pour cet utilisateur | idem                                                                         |
| Octopus bloque la connexion pour le moment (KT-CT-1136)  | blocage passager, vu avec des identifiants valides       | pause d'1 heure, doublée jusqu'à 6 heures                                    |
| Octopus a demandé de ralentir                            | HTTP 429 ou KT-CT-1199                                   | pause de Retry-After ou 15 minutes, doublée jusqu'à 6 heures                 |
| Octopus a un problème                                    | HTTP 5xx ou KT-CT-7899                                   | pause de 5 minutes, doublée jusqu'à 6 heures                                 |
| Octopus n'a pas pu être lu                               | réseau, délai, réponse illisible, requête refusée        | nouvel essai après 5, 10, 20, 40 puis toutes les 60 minutes                  |

Un 401 ou 403 répondu à une requête (pas à la connexion) n'est jamais pris
pour un mot de passe refusé : une nouvelle connexion, puis une erreur
passagère. Les pauses et le refus sont gardés dans `/data` (le refus comme
8 bits d'une empreinte salée des identifiants, jamais les identifiants).

**La nouvelle connexion d'Octopus.** Octopus a marqué comme dépréciée en 2026
la connexion par e-mail et mot de passe de son API. Si le site accepte votre
mot de passe mais que l'intégration le dit refusé, votre compte utilise
peut-être la nouvelle connexion : une clé d'API du compte fonctionne encore
(demandez-en une à Octopus).

## Ce que contient `/data`

`/data/octopus-germany.json` : l'heure des dernières lectures, la pause, le
refus (8 bits d'une empreinte salée), les MaLo vues (empreinte, 4 derniers
chiffres, nom du tarif, compteur communicant ou non) et les prix des 40
derniers jours. Jamais l'adresse e-mail, le mot de passe, un jeton, le numéro
de compte ni un numéro de MaLo complet.

## Limites

- Électricité seulement : le gaz, l'injection (export) et le solde du compte
  ne sont pas lus.
- Les recharges prévues d'Intelligent Octopus ne changent pas le prix calculé
  ici : ce sont les plages horaires du tarif qui comptent.
- Jamais testée avec un vrai compte (voir plus haut) : les réponses sont lues
  strictement, et une réponse de forme inattendue est une erreur passagère,
  jamais une valeur fausse.

## Crédits

Les requêtes GraphQL sont adaptées d'octopus_germany de thecem (MIT,
github.com/thecem/octopus_germany), comme la lecture des tarifs et des
mesures, réécrite en JavaScript. Notice dans `THIRD_PARTY_NOTICES.md`.
