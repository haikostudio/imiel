/// <reference path="../pb_data/types.d.ts" />

// Regroupement cross-thread : une fiche de suivi peut couvrir PLUSIEURS fils
// d'emails (mail marchand + paiement PayPal + expedition transporteur...). On
// ajoute `thread_ids` (liste de tous les threads rattaches a la fiche). Le champ
// `thread_id` historique reste le thread principal.
migrate(
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    items.fields.add(new Field({ name: "thread_ids", type: "json", maxSize: 20000 }));
    app.save(items);
  },
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    items.fields.removeByName("thread_ids");
    app.save(items);
  }
);
