# iMiel

**Vos mails, votre agenda et vos affaires en un seul endroit — logiciel libre.**
*[English below](#english)*

iMiel réunit vos boîtes mail, votre agenda, vos contacts, le suivi de vos
commandes et dossiers, vos newsletters et un assistant, dans une seule
application. Le code est publié sous licence libre **AGPL-3.0** : vous pouvez
le lire, l'installer chez vous et l'améliorer.

Site : [getimiel.com](https://getimiel.com)

## Ce que fait iMiel

| Service | Ce qu'il apporte |
| --- | --- |
| **Mail** | Plusieurs comptes (IMAP/SMTP, POP3, Gmail), conversations, recherche plein texte et par le sens, tri des mails importants, envoi programmé, annulation d'envoi, suivi de lecture. |
| **Agenda** | Synchronisation avec Google Agenda, invitations reçues par mail ajoutées en un geste, vues mois, semaine, année et liste, rappels. |
| **Contacts** | Carnet tenu à jour depuis vos échanges, historique des conversations par personne. |
| **Suivi** | Une fiche par affaire (commande, livraison, rendez-vous, facture) qui se met à jour toute seule à chaque nouveau mail, codes de retrait et échéances compris. |
| **Newsletters** | Les lettres que vous suivez, résumées et rangées dans un flux à part. |
| **Assistant** | Répond sur vos mails, propose des réponses, corrige et traduit — avec **votre** clé d'IA ([OpenRouter](https://openrouter.ai)). Sans clé, l'IA reste éteinte. |

Application web installable sur téléphone, application de bureau
(Mac, Windows, Linux) et application iPhone avec widgets.

## Installer iMiel sur votre serveur

Prérequis : Docker et Docker Compose.

```bash
git clone https://github.com/haikostudio/imiel.git
cd imiel
cp .env.example .env
# Remplissez au moins :
#   ENCRYPTION_KEY        -> openssl rand -hex 32
#   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY -> npx web-push generate-vapid-keys
#   PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD   -> le compte administrateur de la base
#   NEXT_PUBLIC_APP_URL   -> l'adresse où iMiel sera servi
docker compose up -d
```

- L'application répond sur le port `3000`, la base (PocketBase) sur `8090`,
  le service de relève sur `4001`. Placez un proxy HTTPS devant le port `3000`.
- Au premier démarrage, créez le compte administrateur de la base sur
  `http://<serveur>:8090/_/`, avec les identifiants mis dans `.env`, puis
  votre compte d'utilisateur.
- Le filtre anti-spam (Rspamd) est facultatif : sans lui, iMiel fonctionne et
  s'appuie sur ses autres signaux.

### Gmail

Le plus simple : un **mot de passe d'application** Google
(Compte Google → Sécurité → Mots de passe des applications), puis
`imap.gmail.com:993` (SSL) et `smtp.gmail.com:465` (SSL). La connexion
« Se connecter avec Google » demande votre propre client OAuth
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).

## Développer

```bash
npm install                                   # outils de la racine
(cd frontend && npm install)                  # interface (Next.js)
(cd backend/mail-worker && npm install)       # service de relève
npm run dev:pb   # base locale sur 127.0.0.1:8090 (binaire PocketBase 0.25.9 dans backend/)
npm run dev      # service de relève + interface sur http://localhost:13000
```

Contrôles avant toute proposition de changement :

```bash
cd frontend && npx tsc --noEmit && npx next build && npm test
cd backend/mail-worker && npx tsc --noEmit && npm test
```

## Organisation du dépôt

| Dossier | Contenu |
| --- | --- |
| `frontend/` | Interface (Next.js, React, TypeScript, Tailwind). |
| `backend/pb_hooks`, `backend/pb_migrations` | Base PocketBase : règles, routes et migrations. |
| `backend/mail-worker/` | Relève IMAP/POP3, envoi SMTP, recherche, IA, agenda, notifications. |
| `desktop/` | Application de bureau (Tauri). |
| `mobile/` | Application iPhone (Capacitor + widgets WidgetKit). |
| `mcp/imiel-mcp/` | Serveur MCP pour piloter sa boîte depuis un agent. |
| `site/` | La vitrine getimiel.com (site statique, 4 langues). |
| `docs/API.md` | Les routes de l'API. |

## Contribuer, sécurité, licence

- Pour proposer un changement : [CONTRIBUTING.md](CONTRIBUTING.md).
- Pour signaler une faille, **pas de ticket public** : [SECURITY.md](SECURITY.md).
- Licence : [GNU AGPL-3.0](LICENSE). Si vous proposez iMiel modifié à d'autres
  personnes au travers d'un réseau, vous devez leur donner accès à votre code.

---

<a id="english"></a>

# iMiel — English

**Your mail, calendar and ongoing matters in one place — free software.**

iMiel brings together your mailboxes, calendar, contacts, order and case
tracking, newsletters and an assistant in a single app. The code is released
under the **AGPL-3.0** license: read it, self-host it, improve it.

Website: [getimiel.com](https://getimiel.com)

## Features

| Service | What it does |
| --- | --- |
| **Mail** | Multiple accounts (IMAP/SMTP, POP3, Gmail), threads, full-text and semantic search, important-mail sorting, scheduled send, undo send, read receipts. |
| **Calendar** | Google Calendar sync, one-tap invitations from email, month, week, year and list views, reminders. |
| **Contacts** | An address book kept up to date from your conversations. |
| **Tracking** | One card per matter (order, delivery, appointment, invoice) that updates itself with every new email, pickup codes and deadlines included. |
| **Newsletters** | The newsletters you follow, summarised in their own feed. |
| **Assistant** | Answers questions about your mail, drafts replies, proofreads and translates — with **your own** AI key ([OpenRouter](https://openrouter.ai)). No key, no AI. |

Installable web app, desktop app (macOS, Windows, Linux) and iPhone app with
widgets.

## Self-hosting

Requirements: Docker and Docker Compose.

```bash
git clone https://github.com/haikostudio/imiel.git
cd imiel
cp .env.example .env
# Fill in at least ENCRYPTION_KEY (openssl rand -hex 32), the VAPID keys
# (npx web-push generate-vapid-keys), PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD and
# NEXT_PUBLIC_APP_URL.
docker compose up -d
```

The app listens on port `3000` (put an HTTPS proxy in front of it), the
PocketBase database on `8090` and the mail service on `4001`. On first start,
create the database admin at `http://<server>:8090/_/` using the credentials
from `.env`, then your user account. Rspamd is optional.

**Gmail:** use a Google *app password* with `imap.gmail.com:993` and
`smtp.gmail.com:465` (SSL). "Sign in with Google" requires your own OAuth
client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).

## Development

```bash
npm install && (cd frontend && npm install) && (cd backend/mail-worker && npm install)
npm run dev:pb   # local PocketBase on 127.0.0.1:8090
npm run dev      # mail service + UI on http://localhost:13000
```

Before opening a pull request: `npx tsc --noEmit`, `npx next build` and
`npm test` in `frontend/`, `npx tsc --noEmit` and `npm test` in
`backend/mail-worker/`.

## Contributing, security, license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) (no
public issues for vulnerabilities). Licensed under the
[GNU AGPL-3.0](LICENSE).
