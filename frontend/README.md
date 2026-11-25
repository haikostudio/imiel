# iMiel Frontend

Frontend Next.js 16 / React 19 d'iMiel.

## Commandes

```bash
npm install
npm run dev          # http://localhost:13000
npm test             # Vitest
npx tsc --noEmit     # typecheck obligatoire
npx next build       # build obligatoire
```

Depuis la racine du repo, `npm run dev` lance aussi le mail-worker et le
service LibreTranslate legacy. PocketBase local se lance separement avec
`npm run dev:pb`.

## Structure

- `src/app` : App Router, layouts, pages et routes API.
- `src/components` : composants UI, mail, settings, dashboard, layout.
- `src/lib/hooks` : hooks metier.
- `src/lib/stores` : stores Zustand.
- `src/lib/pocketbase.ts` : client PocketBase et types frontend.
- `src/lib/i18n.ts` : traductions `fr`, `en`, `de`, `it`.

## Regles

- Next tourne sur le port 13000, pas 3000.
- Pas de texte visible hardcode : utiliser `t(key, language)`.
- Ajouter les nouvelles cles dans les 4 langues.
- Garder les valeurs de traduction sans accents.
- Utiliser shadcn/ui et Lucide avant du custom.
- Ne pas casser `turbopack.root` dans `next.config.ts`; si ce fichier change,
  supprimer `.next` avant de relancer.

## API

Les rewrites `next.config.ts` proxyfient :

- `/api/*` vers PocketBase.
- `/_/*` vers l'admin PocketBase.
- `/worker/*` vers le mail-worker.

Les routes Next locales sous `src/app/api/ai` et `src/app/api/translate`
utilisent OpenRouter via `OPENROUTER_API_KEY`.
