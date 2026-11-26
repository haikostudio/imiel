# App web iMiel Cloud (app.getimiel.com)

L'app web est la même interface que l'app d'ordinateur et l'iPhone, livrée en fichiers statiques. **Sa base vit dans le navigateur.** Les mails sont gardés dans le stockage du navigateur (IndexedDB, stockage persistant demandé), derrière le même jeu d'appels que la base de l'app. Ce stockage est réalisé dans `frontend/src/lib/cloud/web/`.

Le serveur de transfert (`sync.getimiel.com`) relève les boîtes et transmet. Le serveur de l'app web ne sert que des fichiers.

## Fabriquer

```bash
IMIEL_CLOUD_URL=https://sync.getimiel.com node mobile/scripts/construire-interface-locale.mjs --web
# -> cloud/app-web/site (non versionné)
```

## Servir (écrit, NON déployé)

Le service `app-web` de `cloud/deploiement/docker-compose.yml` sert l'app avec nginx (`nginx.conf`) sous `app.getimiel.com`. Il faut le DNS et le feu vert de l'éditeur.

## Ce que l'app web ne fait pas (encore)

- **Assistant IA, traduction, résumés.** Il n'y a pas de serveur d'app : ils sont masqués.
- **Envoi programmé.** Il est refusé avec un message.
- **Suivi de lecture des mails envoyés, images distantes par le proxy.** Ces fonctions demandent le releveur, qui n'existe pas dans le navigateur.
- **Vignettes des pièces jointes d'un brouillon.** Le fichier est bien gardé et envoyé, mais l'aperçu n'est pas affiché.
