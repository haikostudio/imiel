# Contribuer à iMiel

Merci de votre intérêt ! *(English below.)*

1. **Ouvrez d'abord un ticket** pour tout changement d'ampleur (nouvel écran,
   nouveau service, changement de la base) : on s'accorde sur l'idée avant
   le code.
2. **Une branche par sujet**, partie de `main`, et une demande de fusion
   (pull request) qui dit ce qui change et comment le vérifier.
3. **Les contrôles passent** avant l'envoi :
   - `frontend/` : `npx tsc --noEmit`, `npx next build`, `npm test` ;
   - `backend/mail-worker/` : `npx tsc --noEmit`, `npm test`.
4. **Les conventions du projet** :
   - textes de l'interface dans les 4 langues (`frontend/src/lib/i18n.ts` : fr, en, de, it) ;
   - un changement de la base passe par une migration numérotée dans
     `backend/pb_migrations/` ;
   - les hooks PocketBase sont en JavaScript (`*.pb.js`), sans `go()` ni
     opérateur de décomposition `[...]` ;
   - aucune donnée réelle (nom, adresse, capture d'une vraie boîte) dans le
     code, les tests ou les captures : utilisez des domaines d'exemple
     (`example.com`).
5. **Licence** : en proposant un changement, vous acceptez qu'il soit publié
   sous la licence du projet, la GNU AGPL-3.0.

## English

Open an issue first for anything substantial, work on a topic branch from
`main`, and make sure the checks above pass before opening a pull request.
UI strings go into all four languages (`frontend/src/lib/i18n.ts`), database
changes go through a numbered migration, and no real personal data may appear
in code, tests or screenshots. By contributing you agree that your work is
released under the project's GNU AGPL-3.0 license.
