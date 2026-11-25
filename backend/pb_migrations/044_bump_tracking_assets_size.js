/// <reference path="../pb_data/types.d.ts" />

// Les QR/codes-barres trouves dans les CORPS de mails (images distantes) sont
// embarques en data URI dans tracking_items.assets pour rester visibles apres
// expiration de l'URL distante -> il faut plus de place que les 100 Ko initiaux.
migrate(
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    const f = items.fields.getByName("assets");
    f.maxSize = 600000;
    app.save(items);
  },
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    const f = items.fields.getByName("assets");
    f.maxSize = 100000;
    app.save(items);
  }
);
