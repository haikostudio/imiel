/// <reference path="../pb_data/types.d.ts" />

// 1) Index (is_starred, is_draft, date) pour la vue "Favoris".
// 2) ANALYZE : genere les statistiques SQLite (sqlite_stat1) que PocketBase ne
//    produit jamais. Sans stats, le planificateur suppose des selectivites par
//    defaut (~50%) et choisit de mauvais ordres de jointure : pour la vue
//    favoris tous-comptes il attaque par `accounts` (5 lignes) et, comme l'ordre
//    date n'est plus global, fait USE TEMP B-TREE FOR ORDER BY en relisant la
//    LIGNE complete (html_body inline, ~118 Ko) de chaque mail favori (~2500)
//    => 4,8 s a froid sur un VPS sous pression memoire.
//    Avec ANALYZE, le planificateur sait que is_starred/is_draft sont selectifs,
//    attaque par `messages` via l'index ci-dessous (deja en ordre date DESC,
//    pas de temp b-tree), joint accounts par rowid et ne lit la grosse ligne que
//    pour les 50 resultats. Mesure sur copie prod : 4,8 s -> 0,004 s. ANALYZE
//    corrige aussi globalement le planning des autres vues.
//
// Note : ANALYZE lit la table messages (~4 Go) une fois, ~1 min sur ce VPS.
// C'est ponctuel (la migration ne s'execute qu'une fois). Les stats restent
// valables tant que les distributions ne changent pas radicalement.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_starred_draft_date` ON `messages` (`is_starred`, `is_draft`, `date`)";
    if (!messages.indexes.includes(idx)) {
      messages.indexes.push(idx);
    }
    app.save(messages);

    try {
      app.db().newQuery("ANALYZE").execute();
    } catch (e) {
      console.log("034 ANALYZE failed: " + e);
    }
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const idx =
      "CREATE INDEX `idx_msg_starred_draft_date` ON `messages` (`is_starred`, `is_draft`, `date`)";
    messages.indexes = messages.indexes.filter((i) => i !== idx);
    app.save(messages);
  }
);
