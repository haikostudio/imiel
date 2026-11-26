# Dossier App Store : iMiel pour tous (copie complète sur l'iPhone)

Fiche App Store Connect 1234567890 (`studio.haiko.imiel`). Ce dossier est **préparé, pas envoyé**. Rien ne part chez Apple sans le feu vert de l'éditeur.

## Étiquettes de confidentialité (« App Privacy »)

| Donnée | Collectée ? | Pourquoi |
|---|---|---|
| Courriels, contacts, agenda, suivis | **Non collectés** | Ils restent sur l'appareil, dans la base embarquée. Entre les appareils de l'utilisateur, ils transitent chiffrés de bout en bout : le nuage ne peut pas les lire, ni personne d'autre. |
| Adresse e-mail du compte chiffré | **Oui** (facultatif), liée à l'utilisateur, sans pistage | Elle sert à se connecter au nuage et à recevoir le code de confirmation, seulement si l'utilisateur crée un compte chiffré. |
| Identifiants d'appareil / jeton de notification | **Oui**, lié à l'utilisateur, sans pistage | Ils servent à livrer les notifications. L'aperçu est scellé pour l'iPhone. |
| Données d'usage, diagnostics, publicité | **Non** | Aucun outil de mesure ni de publicité. |

Réponse à « Données utilisées pour vous pister » : **Non**.

## Chiffrement (export)

`ITSAppUsesNonExemptEncryption` vaut aujourd'hui `false`. La copie complète utilise un chiffrement **standard** :

- XChaCha20-Poly1305 et X25519 (libsodium) ;
- Argon2id ;
- SRP-6a ;
- TLS.

Ce chiffrement protège les données de l'utilisateur. Il relève de l'exemption « mass market » (catégorie 5 partie 2, note 3). À déclarer dans App Store Connect au moment de l'envoi, en gardant `false` pour l'exemption.

## Notes pour l'examen (App Review)

> iMiel est une messagerie qui garde tout sur l'appareil. Au premier lancement, la base de données intégrée démarre dans l'app : aucun serveur n'est nécessaire pour lire ses mails.
>
> Pour l'essai, ajoutez une boîte IMAP de test (Réglages > Comptes mail), ou reliez un compte chiffré existant. Pour cela, choisissez Réglages > Compte chiffré > « J'ai déjà un compte chiffré », puis saisissez l'adresse, le mot de passe principal et la clé secrète du compte de démonstration fourni ci-dessous.
>
> La suppression du compte se fait dans l'app : Réglages > Compte chiffré > « Supprimer le compte chiffré » (règle 5.1.1(v)).

Compte de démonstration : **à créer sur le nuage en service, au moment de l'envoi** (adresse, mot de passe principal et clé secrète). Ses accès vont au coffre-fort de Beluga, dans une fiche par secret.

## Adresses à renseigner

- Politique de confidentialité : https://getimiel.com/confidentialite (page de la vitrine, à vérifier avant l'envoi).
- Assistance : hello@getimiel.com.

## Avant l'envoi (décision de l'éditeur)

1. Mettre en service le nuage (`cloud/deploiement`, DNS de sync.getimiel.com).
2. Passer l'essai `mobile-ios-copie-locale.yml`.
3. Créer le compte de démonstration.
4. Envoyer la fabrication pour TestFlight par l'étiquette `mobile-ios-v<version>-b<n>`, avec l'option de copie complète ajoutée à `mobile-ios.yml`.
