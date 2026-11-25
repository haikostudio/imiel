/// <reference path="../pb_data/types.d.ts" />

// Repare l'autogeneration de l'id sur push_tokens et filter_rules.
//
// Les migrations 1772142033_updated_filter_rules.js et
// 1772142042_updated_push_tokens.js ont ecrase le champ `id` avec
// `autogeneratePattern: ""` et `min/max: 0`, ce qui desactive la
// generation automatique. Resultat : tout POST sans `id` retournait
// 400 `id: validation_required` (frontend incapable d'enregistrer
// les push tokens, par exemple).

migrate(
  (app) => {
    var collections = ["push_tokens", "filter_rules"];
    for (var i = 0; i < collections.length; i++) {
      var collection = app.findCollectionByNameOrId(collections[i]);
      collection.fields.addAt(
        0,
        new Field({
          autogeneratePattern: "[a-z0-9]{15}",
          hidden: false,
          id: "text3208210256",
          max: 15,
          min: 15,
          name: "id",
          pattern: "^[a-z0-9]+$",
          presentable: false,
          primaryKey: true,
          required: true,
          system: true,
          type: "text",
        })
      );
      app.save(collection);
    }
  },
  (app) => {
    var collections = ["push_tokens", "filter_rules"];
    for (var i = 0; i < collections.length; i++) {
      var collection = app.findCollectionByNameOrId(collections[i]);
      collection.fields.addAt(
        0,
        new Field({
          autogeneratePattern: "",
          hidden: false,
          id: "text3208210256",
          max: 0,
          min: 0,
          name: "id",
          pattern: "^[a-z0-9]+$",
          presentable: false,
          primaryKey: true,
          required: true,
          system: true,
          type: "text",
        })
      );
      app.save(collection);
    }
  }
);
