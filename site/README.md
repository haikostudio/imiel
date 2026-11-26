# Vitrine getimiel.com

Site statique de présentation d'iMiel, en français, anglais, allemand et italien,
en clair et en sombre. Aucune dépendance : un seul script le fabrique.

```bash
node site/build.mjs                    # fabrique site/dist
node site/scripts/serve.mjs 4321       # l'essayer sur http://127.0.0.1:4321/
PLAYWRIGHT_CORE=/chemin/playwright-core/index.mjs node site/scripts/verifier-vitrine.mjs /tmp/captures
```

- `src/content.mjs` : tous les textes, par langue, et les adresses des pages.
- `src/site.css` : la page est en flux sur un fond pleine largeur ; seule la scène
  de la démo (1440 px) garde des positions fixes, mise à l'échelle par `zoom`
  au-dessous de 1440 px. Sous 1100 px, tout passe en colonne et le fil longe le
  bord gauche.
- `src/app.js` : thème, langue, bouton de téléchargement selon l'appareil, démo au
  curseur (vraies captures, un service après l'autre), apparitions au défilement
  (par le bas en descendant, par le haut en remontant), FAQ animée, et l'avion qui
  suit le fil. Le fil est tracé sur les boîtes réelles de la page : une polyligne
  dont chaque coin devient un arc (rayon ≤ 230 px) puis lissée — jamais d'angle
  droit. Tout s'arrête si l'appareil demande moins d'animations.
- `scripts/verifier-vitrine.mjs` : contrôle en vrai navigateur (1920, 1440, 390,
  4 langues, clair et sombre) — démo visible à l'arrivée, menu collé, bulles,
  rayon minimal du fil ≥ 100 px, aucun croisement avec le contenu, FAQ ouverte.
- `src/assets/img` : vraies captures de l'application, remplies de données
  fictives (aucun vrai nom), en `.webp` clair et sombre (`-sombre`).
- `Dockerfile`, `nginx.conf`, `docker-compose.yml` : hébergement derrière Traefik,
  prêt mais pas mis en ligne.
