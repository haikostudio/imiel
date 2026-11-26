# iMiel Cloud : dossiers de vérification Google et Microsoft

Ces dossiers sont **préparés, pas envoyés**. Les envoyer, créer les clients OAuth de production et poser les DNS de `sync.getimiel.com` sont des décisions de l'éditeur.

## Google (« Se connecter avec Google »)

### Client OAuth

- Type : **application Web**, dans un projet Google Cloud propre à iMiel Cloud.
- Origine : `https://sync.getimiel.com`.
- Adresse de retour : `https://sync.getimiel.com/v1/oauth/google/retour`.
- Variables du serveur : `NUAGE_GOOGLE_ID` et `NUAGE_GOOGLE_SECRET`. Elles vont au coffre-fort, une fiche chacune, dossier `iMiel/Production/Connexion par un compte tiers`.
- Domaine autorisé : `getimiel.com`. Il doit être vérifié dans la Search Console, ce qui suppose un enregistrement DNS.

### Portées demandées

| Portée | Catégorie Google | Pourquoi |
|---|---|---|
| `https://mail.google.com/` | **restreinte** | Le serveur de transfert relève la boîte en IMAP (XOAUTH2) quand les appareils de l'abonné la demandent. Il envoie aussi par SMTP les mails écrits sur l'iPhone ou le web. Aucun mail n'est gardé sur le serveur. |
| `https://www.googleapis.com/auth/calendar` | sensible | L'agenda est synchronisé dans les deux sens (MEM-8236). |
| `openid`, `userinfo.email`, `userinfo.profile` | non sensibles | Ces portées donnent l'adresse de la boîte reliée. |

### Conséquence de la portée restreinte

Les données Gmail passent par un serveur de l'éditeur. Google exige donc deux choses :

1. la **vérification** de l'application : écran d'accord, politique de confidentialité, vidéo de démonstration, justification de chaque portée ;
2. une **évaluation de sécurité annuelle (CASA)** par un laboratoire agréé, payante, à renouveler chaque année.

Tant que ces deux étapes ne sont pas franchies, l'application reste en **mode Test** :

- 100 utilisateurs déclarés au plus, ajoutés à la main dans la console ;
- un écran « Google n'a pas validé cette application » s'affiche à chaque connexion ;
- les jetons expirent après 7 jours.

Pendant ce temps, l'écran d'ajout propose aussi la voie « autre adresse ». Une boîte Gmail peut s'y relier avec un mot de passe d'application (IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:587`).

### Éléments à joindre

1. Page d'accueil : https://getimiel.com
2. Politique de confidentialité : https://getimiel.com/confidentialite/. Elle dit déjà que le serveur relève, transmet puis oublie, ne garde aucun mail, ne vend rien et n'entraîne aucun modèle d'IA, et elle cite la politique Google API Services User Data Policy, y compris l'usage limité.
3. Vidéo à tourner le jour de l'envoi :
   - « Ajouter une boîte » ;
   - « Se connecter avec Google » ;
   - l'accord ;
   - les mails qui arrivent sur l'ordinateur puis sur l'iPhone ;
   - un envoi depuis le web.
4. Questionnaire CASA. Les points à montrer :
   - le chiffrement au repos des réglages (secretbox) ;
   - l'absence de stockage de mails, prouvée par l'essai `cloud/essais/serveur.test.mjs` ;
   - l'isolation entre abonnés, prouvée par le même essai ;
   - des journaux sans contenu ;
   - des jetons d'appareil révocables.

## Microsoft (« Se connecter avec Microsoft »)

### Inscription d'application (Microsoft Entra)

- Comptes pris en charge : **comptes professionnels ET comptes Microsoft personnels** (Outlook.com, Hotmail).
- Adresse de retour (Web) : `https://sync.getimiel.com/v1/oauth/microsoft/retour`.
- Permissions déléguées :
  - `IMAP.AccessAsUser.All` ;
  - `SMTP.Send` ;
  - `offline_access` ;
  - `openid`, `email`, `profile`.
- Variables du serveur : `NUAGE_MICROSOFT_ID` et `NUAGE_MICROSOFT_SECRET`. Une fiche chacune au coffre-fort. Le secret client expire : il faut noter sa date d'expiration dans la fiche.

### Vérification d'éditeur

La vérification d'éditeur (Microsoft Partner Network) affiche « vérifié » sur l'écran d'accord. Sans elle, les comptes professionnels dont l'administrateur bloque les applications non vérifiées ne peuvent pas relier leur boîte.

Le dossier contient :

- le domaine `getimiel.com` vérifié (fichier `/.well-known/microsoft-identity-association.json` sur la vitrine) ;
- l'identifiant MPN de Haiko Studio.

Il n'est **pas envoyé**.

Côté Microsoft 365, l'administrateur doit aussi laisser l'authentification SMTP active pour la boîte (paramètre « SMTP AUTH »).
