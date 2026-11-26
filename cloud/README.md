# iMiel Cloud — le serveur de transfert

iMiel Cloud relie les apps d'un abonné : ordinateur, iPhone et navigateur. Il **relève chaque boîte au passage** et ne **garde aucun mail**. Quand une app demande le courrier, ou quand un mail arrive, il se connecte chez le fournisseur (Gmail, Outlook, Infomaniak…). Il transmet ensuite aux apps, puis il oublie.

Logiciel libre (AGPL-3.0), auto-hébergeable.

## Ce que le serveur garde, et ce qu'il ne garde pas

| Gardé | Comment |
|---|---|
| Le compte | Adresse confirmée par un code, mot de passe haché (Argon2id). |
| L'abonnement | Son état : essai, actif ou arrêté. Les identifiants Stripe du client et de l'abonnement. |
| Les appareils reliés | Nom, genre, jeton de notification iPhone. Les sessions sont gardées par empreinte, jamais en clair. |
| Les réglages | Boîtes et leurs identifiants, signatures, règles, étiquettes, newsletters suivies, apparence, clé d'IA. Ils sont **chiffrés au repos** avec la clé du serveur (libsodium secretbox), car le pont doit pouvoir s'en servir pour relever. |
| La file de transit | Les données propres à iMiel passent d'un appareil à l'autre (étiquettes posées, suivis, notes). Elles sont chiffrées au repos, **effacées dès réception**, et 30 jours au plus. |

| Jamais gardé | |
|---|---|
| Les mails | Ni sujet, ni corps, ni correspondant. Ils sont lus chez le fournisseur au moment où une app les demande, en mémoire. |
| Les pièces jointes | Elles sont lues chez le fournisseur quand on les ouvre, puis transmises sans jamais être écrites sur le disque. |
| Les journaux | Ils notent seulement la méthode, la route, le statut et la durée. Jamais d'adresse, de sujet, de contenu ni de secret. |

Un essai le vérifie (`essais/serveur.test.mjs`). Il relève des mails, puis fouille la base, son journal et tout le dossier du serveur : on n'y trouve aucun sujet, aucun corps, aucun nom de pièce jointe, aucun correspondant et aucun mot de passe.

## Le pont

- **Synchro par curseurs.** Chaque app connaît, par dossier, le plus grand et le plus petit UID qu'elle a reçus, ainsi que l'UIDVALIDITY. Elle les envoie à `POST /v1/synchro`. Le serveur lui rend :
  - les mails nouveaux ;
  - la liste des mails encore présents (les autres ont été supprimés ou déplacés) ;
  - les drapeaux des 800 plus récents.
- **Identifiants stables.** Un mail a le même identifiant sur tous les appareils, calculé à partir de la boîte, du dossier, de l'UIDVALIDITY et de l'UID. Cela sert aussi au dédoublonnage.
- **Historique.** Il est lu à la demande, par pages (`POST /v1/historique`).
- **Pièces jointes.** Elles sont lues à la demande (`GET /v1/pieces`). Les petites images intégrées au corps arrivent avec le mail.
- **Gestes.** Marquer lu, mettre en favori, déplacer, supprimer (`POST /v1/actions`) et envoyer (`POST /v1/envoyer`, par le SMTP du fournisseur, avec une copie dans « Envoyés »). Ils sont appliqués chez le fournisseur, puis annoncés aux autres appareils.
- **Veille.** Une connexion IDLE sur la boîte de réception de chaque boîte d'un compte en essai ou abonné. Un nouveau mail est annoncé en direct (WebSocket `/v1/flux`) et à l'iPhone par APNs (expéditeur et sujet), puis oublié.
- **Connexions.** Deux connexions IMAP au plus par boîte. Celle de travail se ferme après 90 s sans usage ; celle de veille se reconnecte avec une attente croissante.

## Ajouter une boîte sans rien régler

- **Gmail et Outlook.** « Se connecter avec Google / Microsoft » (`POST /v1/boites/oauth/<fournisseur>`).
  - Google : la portée `https://mail.google.com/` est restreinte. Tant que Google n'a pas validé l'application (vérification et évaluation de sécurité annuelle), elle reste en mode Test : 100 utilisateurs déclarés au plus, avec un écran d'avertissement.
- **Les autres boîtes.** L'adresse et le mot de passe suffisent. Les réglages sont trouvés dans cet ordre : fournisseurs connus, base ISPDB de Thunderbird, autoconfig du domaine, SRV (RFC 6186), serveurs MX, puis repli. La connexion est essayée **avant** d'enregistrer.
- **iCloud et Yahoo.** Ces fournisseurs imposent un mot de passe d'application, et l'app guide pour l'obtenir.

## Abonnement

iMiel Cloud coûte 5,99 CHF par mois, avec **14 jours offerts sans carte**.

- **Essai.** C'est un abonnement Stripe sans moyen de paiement. Il se met en pause à la fin de l'essai s'il n'y a pas de carte (`trial_settings.end_behavior.missing_payment_method = pause`). Un rappel part 3 jours avant la fin.
- **Paiement.** Il passe par Stripe Checkout (mode « setup »). La carte est posée sur l'abonnement, qui reprend.
- **Portail client.** Le portail Stripe gère la carte, les factures et la résiliation.
- **Événements reçus** (`POST /v1/stripe/webhook`, signature vérifiée, chaque événement appliqué une seule fois) :
  - `checkout.session.completed` ;
  - `customer.subscription.created` / `updated` / `deleted` / `paused` / `resumed` / `trial_will_end` ;
  - `invoice.paid` ;
  - `invoice.payment_failed`.
- **Arrêt** (essai fini sans carte, résiliation, impayé) :
  - le pont s'arrête pour ce compte et les apps le savent ;
  - l'ordinateur peut continuer en version gratuite : il reprend les identifiants de ses boîtes (`GET /v1/reglages?identifiants=1`, ordinateur seulement) ;
  - un rappel part 7 jours avant l'effacement ;
  - les réglages gardés par le serveur sont effacés 30 jours après l'arrêt.

## Lancer

```bash
cd cloud
npm ci --omit=dev
NUAGE_CLE_REGLAGES="$(openssl rand -hex 32)" \
NUAGE_SECRET="$(openssl rand -hex 32)" \
NUAGE_SMTP="smtp://utilisateur:motdepasse@smtp.example.com:587" \
NUAGE_EXPEDITEUR="iMiel <hello@example.com>" \
NUAGE_HOTE=0.0.0.0 NUAGE_PORT=8787 \
node serveur/serveur.mjs
```

Avec Docker et Traefik, utilisez `deploiement/docker-compose.yml`, avec un `.env` à côté, jamais versionné.

| Variable | Rôle |
|---|---|
| `NUAGE_CLE_REGLAGES` | Clé de chiffrement des réglages (64 caractères hexadécimaux). **Obligatoire** : sans elle, le serveur refuse de démarrer. La perdre rend les réglages illisibles. |
| `NUAGE_SECRET` | Signe les liens de connexion Google et Microsoft. |
| `NUAGE_BASE` | Fichier de la base (`./donnees/nuage.db`). |
| `NUAGE_ADRESSE_PUBLIQUE` | Adresse du serveur vue d'Internet, pour les retours OAuth. |
| `NUAGE_APP_URL` | Adresse de l'app web, pour les retours de paiement. |
| `NUAGE_SMTP`, `NUAGE_EXPEDITEUR` | Codes de confirmation et rappels. |
| `NUAGE_STRIPE_CLE`, `NUAGE_STRIPE_PRIX`, `NUAGE_STRIPE_SECRET_WEBHOOK` | Abonnement. Sans eux, l'essai de 14 jours est tenu par le serveur seul, et le paiement est fermé. |
| `NUAGE_GOOGLE_ID`, `NUAGE_GOOGLE_SECRET`, `NUAGE_MICROSOFT_ID`, `NUAGE_MICROSOFT_SECRET` | « Se connecter avec… ». |
| `NUAGE_APNS_CLE`, `NUAGE_APNS_ID_CLE`, `NUAGE_APNS_EQUIPE`, `NUAGE_APNS_SUJET`, `NUAGE_APNS_PROD` | Notifications iPhone. |
| `NUAGE_MISES_A_JOUR` | Dossier des manifestes signés de l'app d'ordinateur. |
| `NUAGE_GARDE_JOURS` | Garde maximale de la file de transit (30). |
| `NUAGE_VEILLE=0` | Coupe la veille IDLE. |
| `NUAGE_MODE_ESSAI=1` | Essais automatiques seulement : les codes sont rendus dans les réponses, et la clé des réglages est tirée au hasard. |

Il faut Node 22.13 ou plus récent (module SQLite intégré, aucun module natif).

## Essais

```bash
npm test
```
