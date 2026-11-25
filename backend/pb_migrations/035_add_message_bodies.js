/// <reference path="../pb_data/types.d.ts" />

// P2 (sortir les corps de la table messages) - Stage A : collection 1:1
// message_bodies.
//
// CONTEXTE : la table `messages` pese ~2,3 Go car html_body / text_body /
// raw_headers (corps des emails, ~61 Ko/mail en moyenne) sont stockes INLINE.
// Chaque cellule de leaf b-tree porte ~1 Ko de corps en local => leaf bloate,
// les lookups de lignes (scans is_read/is_starred/folder, comptes, planning)
// lisent des Go a froid sur un VPS sous pression memoire (swap). En deplacant
// les corps dans une table separee, `messages` retombe a ~80 Mo et tient en
// cache => toutes les listes/compteurs rapides meme a froid, et le swap diminue.
//
// message_bodies = relation 1:1 vers messages (cascadeDelete : supprimer un
// message supprime son corps). Ecriture reservee au worker / hooks (admin
// token) ; l'utilisateur lit via viewRule. Le snippet reste sur `messages`
// (petit, utilise par le listing).
//
// Cette migration est ADDITIVE et sans risque : elle cree une table vide. Le
// remplissage (036) et la suppression des colonnes source + VACUUM (037) se
// font dans une fenetre de maintenance dediee.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");

    const bodies = new Collection({
      name: "message_bodies",
      type: "base",
      // Lecture : proprietaire du message (via la chaine message.account.user).
      listRule: "@request.auth.id = message.account.user",
      viewRule: "@request.auth.id = message.account.user",
      // Ecriture reservee au worker/hooks (admin token bypass les rules).
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "text_body", type: "editor" },
        { name: "html_body", type: "editor" },
        { name: "raw_headers", type: "text", max: 0 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        // 1:1 strict : un seul corps par message (sert aussi de lookup rapide).
        "CREATE UNIQUE INDEX `idx_msgbodies_message` ON `message_bodies` (`message`)",
      ],
    });
    app.save(bodies);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("message_bodies"));
    } catch (_) {}
  }
);
