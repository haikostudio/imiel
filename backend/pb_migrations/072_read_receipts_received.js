/// <reference path="../pb_data/types.d.ts" />

// Suivi de lecture : nouvel evenement "received". Gmail, Outlook... chargent le
// pixel des l'arrivee du mail pour le controler (scan de livraison) ; ce
// passage, autrefois ignore, sert desormais de preuve de RECEPTION (jamais
// compte comme une vue). Les lignes existantes ne changent pas.
migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("read_receipts");
    const kind = col.fields.getByName("kind");
    if (kind && kind.values.indexOf("received") === -1) {
      kind.values = ["sent", "opened", "received"];
      app.save(col);
    }
  },

  (app) => {
    // Les evenements "received" disparaissent avec la valeur.
    app.db().newQuery("DELETE FROM read_receipts WHERE kind = 'received'").execute();
    const col = app.findCollectionByNameOrId("read_receipts");
    const kind = col.fields.getByName("kind");
    if (kind) {
      kind.values = ["sent", "opened"];
      app.save(col);
    }
  }
);
