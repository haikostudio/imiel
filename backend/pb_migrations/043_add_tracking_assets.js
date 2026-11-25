/// <reference path="../pb_data/types.d.ts" />

// Assets d'une fiche de suivi : QR codes trouves dans les PJ des mails des fils
// rattaches (bon de retrait, etiquette point relais...). Structure :
// { scanned: [attachmentId...], qr: [{ attachment, message, file, data, date }] }
// `scanned` memorise les PJ deja examinees (scan incremental, sans re-telecharger).
migrate(
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    items.fields.add(new Field({ name: "assets", type: "json", maxSize: 100000 }));
    app.save(items);
  },
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    items.fields.removeByName("assets");
    app.save(items);
  }
);
