/// <reference path="../pb_data/types.d.ts" />

// Index composite (is_read, date) pour la vue "Non lus" (onglet unread).
//
// PROBLEME : la requete de l'onglet "non lus" (/api/mail/list?view=unread) :
//   SELECT ... FROM messages m JOIN accounts a ON m.account=a.id
//   JOIN folders f ON m.folder=f.id
//   WHERE a.user=? AND m.is_read=FALSE AND f.type NOT IN ('spam','trash','drafts')
//   ORDER BY m.date DESC LIMIT 20
// Sans statistiques (PocketBase ne lance jamais ANALYZE), le planificateur
// suppose que is_read=FALSE matche ~50% des lignes : il attaque par compte
// (idx_msg_account_draft_date, prefixe account seul), scanne TOUS les mails de
// chaque compte (~34k) et lit la LIGNE complete de chacun pour filtrer is_read
// + trier en TEMP B-TREE. Comme les lignes `messages` sont enormes (html_body +
// raw_headers inline, ~118 Ko/ligne) sur un VPS sous pression memoire, ca lit
// plusieurs Go a froid => 3,8 s par requete.
//
// FIX : index (is_read, date). Le planificateur attaque alors par la branche
// messages (SEARCH m USING idx_msg_read_date (is_read=?)), ne parcourt QUE les
// mails non lus (ici ~345) deja dans l'ordre date DESC (pas de temp b-tree),
// puis joint accounts/folders par rowid et ne lit la grosse ligne que pour les
// 20 resultats finaux. Mesure sur copie prod : 3,8 s -> 0,011 s, SANS ANALYZE.
//
// La string d'index reprend la forme normalisee par PocketBase (backticks) pour
// que le garde .includes() soit idempotent si l'index a deja ete cree a chaud.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_read_date` ON `messages` (`is_read`, `date`)";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
    }
    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_read_date` ON `messages` (`is_read`, `date`)";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
