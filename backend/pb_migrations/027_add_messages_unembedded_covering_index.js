/// <reference path="../pb_data/types.d.ts" />

// Index COUVRANT pour la detection des mails non-embeddes (backfill semantique).
//
// PROBLEME : le backfill embeddings (worker, top-up toutes les 15 min) appelle
// /api/mail/embeddings/unembedded-count et /unembedded, qui font :
//   SELECT ... FROM messages m JOIN accounts a ON m.account=a.id
//   LEFT JOIN mail_embeddings e ON e.message=m.id
//   WHERE a.user=? AND m.is_draft=0 AND e.id IS NULL ORDER BY m.date DESC
// Pour trouver les quelques mails non indexes, il faut examiner TOUS les mails
// du compte (~34k). Les index existants (account, is_draft, date) ne sont pas
// couvrants : pour recuperer m.id (cle du LEFT JOIN) il faut lire la LIGNE
// complete de chaque message. Or les lignes `messages` sont grosses (html_body
// + raw_headers inline, ~118 Ko/ligne) => lecture de ~4 Go a chaque scan =>
// 34-56 s par requete. Comme 4 mails vides (sans sujet/corps/expediteur) ne
// peuvent jamais etre embeddes, le top-up les redetecte indefiniment et relance
// ce scan toutes les 15 min, saturant PocketBase (head-of-line blocking : la
// liste de conversations et le reste de l'app se retrouvent en file d'attente
// derriere, d'ou "l'app n'a plus acces a la db").
//
// FIX : index couvrant (account, is_draft, date, id). Le planificateur lit
// uniquement l'index (jamais les grosses lignes) pour filtrer + ordonner +
// fournir la cle de jointure. Mesure : COUNT 34.8 s -> 0.04 s.
//
// La string d'index reprend exactement la forme normalisee par PocketBase
// (backticks) pour que le garde .includes() soit idempotent si l'index a deja
// ete cree a chaud via l'API sur une instance existante.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_unembedded_cov` ON `messages` (`account`, `is_draft`, `date`, `id`)";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
    }
    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_unembedded_cov` ON `messages` (`account`, `is_draft`, `date`, `id`)";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
