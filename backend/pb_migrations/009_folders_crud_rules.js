/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId("folders");
    // Autoriser create/update/delete pour les dossiers de l'utilisateur authentifie
    collection.createRule = "@request.auth.id = account.user";
    collection.updateRule = "@request.auth.id = account.user";
    collection.deleteRule = "@request.auth.id = account.user";
    app.save(collection);
  },
  (app) => {
    const collection = app.findCollectionByNameOrId("folders");
    collection.createRule = null;
    collection.updateRule = null;
    collection.deleteRule = null;
    app.save(collection);
  }
);
