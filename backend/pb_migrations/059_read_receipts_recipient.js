/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("read_receipts");

    // Adresse du destinataire qui a charge le pixel. Vide pour les evenements
    // "sent" et pour les ouvertures enregistrees avant le suivi par personne.
    if (!col.fields.getByName("recipient")) {
      col.fields.add(
        new Field({
          name: "recipient",
          type: "text",
          max: 320,
        })
      );
    }

    app.save(col);
  },

  (app) => {
    const col = app.findCollectionByNameOrId("read_receipts");
    col.fields.removeByName("recipient");
    app.save(col);
  }
);
