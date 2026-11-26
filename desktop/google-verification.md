# Dossier de vérification Google : agenda de l'app d'ordinateur

Ce dossier est **préparé, pas envoyé**. L'envoi à Google est une décision de l'éditeur.

## Client OAuth

- Type : **application de bureau** (« Desktop app »).
- Retour : boucle locale `http://127.0.0.1:<port>/api/oauth/google/callback`. Le port est choisi sur la machine ; Google accepte tout port en boucle locale pour ce type de client.
- PKCE S256 obligatoire (le vérificateur voyage chiffré dans `state`).
- Identifiant fourni à la fabrication : `IMIEL_GOOGLE_DESKTOP_CLIENT_ID` (+ `IMIEL_GOOGLE_DESKTOP_CLIENT_SECRET`, non confidentiel pour ce type de client), écrit dans `pile.json` par `desktop/scripts/preparer-pile.mjs`. Les deux valeurs vont au coffre-fort, une fiche chacune, à la création du client.

## Portées demandées

| Portée | Catégorie Google | Pourquoi |
|---|---|---|
| `https://www.googleapis.com/auth/calendar` | sensible (examen gratuit) | Synchronisation complète de l'agenda : lecture, création, modification et suppression d'événements, dans les deux sens (MEM-8236). |
| `userinfo.email`, `userinfo.profile` | non sensibles | Rattacher l'agenda à la boîte Gmail déjà ajoutée. |

`https://mail.google.com/` n'est **pas** demandée par la version pour tous. C'est une portée restreinte, qui impose un audit de sécurité annuel. Le courrier Gmail passe par un mot de passe d'application, en IMAP et SMTP.

## Éléments à joindre

1. Page d'accueil : https://getimiel.com.
2. Politique de confidentialité, qui doit dire que les données d'agenda restent sur l'appareil, sans serveur de l'éditeur.
3. Vidéo de démonstration (à tourner le jour de l'envoi) : Réglages > Agenda > « Relier Google », accord dans le navigateur, puis agendas synchronisés.
4. Justification de la portée `calendar` : voir le tableau ci-dessus.

## Où les données vont

Uniquement sur l'ordinateur de l'utilisateur, dans la base locale. Si le compte chiffré est actif, elles passent aussi par ses autres appareils, chiffrées de bout en bout.
