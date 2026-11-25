/// <reference path="../pb_data/types.d.ts" />

// Index COUVRANT du "dernier message d'une conversation" (thread tail).
//
// GET /api/mail/list?with_tails=true renvoie, pour chaque fil present dans la
// page, son DERNIER message tous dossiers confondus (envoyes compris, hors
// brouillons / corbeille / spam) : la ligne de conversation affiche ainsi sa
// propre reponse, comme Gmail, et le rappel "attend une reponse" sait si le fil
// a deja ete repondu.
//
// La table `messages` porte encore ~2,2 Go de corps inline : le driver SQLite
// pur-Go de PocketBase lit la ligne ENTIERE a chaque fetch (cf. migration 036).
// La recherche par thread_id doit donc etre servie integralement depuis un
// index : (thread_id, is_draft, date) en tete pour le seek + le tri, puis
// toutes les colonnes projetees par la requete des "tails" dans mail-list.pb.js.
// Toute colonne ajoutee a ce SELECT doit etre ajoutee ICI (nouvelle migration).
//
// Mesure sur la base prod (38k mails) : 50 fils -> 69 lignes, SEARCH USING
// COVERING INDEX, ~1 ms. Creation additive (pas de VACUUM) ; elle lit toute la
// table une fois au demarrage de PB (quelques minutes sur 4 Go).

var TAIL_IDX =
  "CREATE INDEX `idx_msg_thread_tail` ON `messages` " +
  "(`thread_id`, `is_draft`, `date`, `id`, `account`, `folder`, `message_id`, " +
  "`from_address`, `to_addresses`, `cc_addresses`, `subject`, `snippet`, " +
  "`is_read`, `is_answered`, `is_sent`, `has_attachments`, `labels`)";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    if (!messages.indexes.includes(TAIL_IDX)) messages.indexes.push(TAIL_IDX);
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.indexes = messages.indexes.filter((i) => i !== TAIL_IDX);
    app.save(messages);
  }
);
