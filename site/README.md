# Vitrine getimiel.com

Site statique de présentation d'iMiel, en français, anglais, allemand et italien,
en clair et en sombre. Aucune dépendance : un seul script le fabrique.

```bash
node site/build.mjs                    # fabrique site/dist
node site/scripts/serve.mjs 4321       # l'essayer sur http://127.0.0.1:4321/
PLAYWRIGHT_CORE=/chemin/playwright-core/index.mjs node site/scripts/verifier-vitrine.mjs /tmp/captures
```

- `src/content.mjs` : tous les textes, par langue, et les adresses des pages.
- `src/site.css` : sur ordinateur (≥ 1100 px), la page est une scène de 1440 px
  qui reprend au pixel la maquette validée, mise à l'échelle par `zoom` ; sur
  téléphone, le même contenu passe en flux.
- `src/app.js` : thème (choix gardé, sinon celui de l'appareil), bouton de
  téléchargement selon l'appareil, écrans du haut qui défilent, et l'avion du
  logo qui suit le fil en tirets pendant le défilement (immobile si l'appareil
  demande moins d'animations).
- `src/assets/img` : vraies captures de l'application, remplies de données
  fictives (aucun vrai nom), en `.webp` clair et sombre (`-sombre`).
- `Dockerfile`, `nginx.conf`, `docker-compose.yml` : hébergement derrière Traefik,
  prêt mais pas mis en ligne.
