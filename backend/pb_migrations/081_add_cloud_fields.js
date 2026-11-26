/// <reference path="../pb_data/types.d.ts" />

// iMiel Cloud : sur un appareil relie au serveur de transfert, les boites sont
// RELEVEES PAR LE SERVEUR. Leurs fiches « accounts » locales n'ont aucun mot de
// passe et ne doivent jamais etre relevees par le releveur local
// (cloud_managed). Les pieces jointes arrivent sans leur contenu : il est lu
// chez le fournisseur a l'ouverture, par son rang dans le mail (cloud_index).
migrate(
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");
    if (!accounts.fields.getByName("cloud_managed")) {
      accounts.fields.add(new Field({ name: "cloud_managed", type: "bool" }));
    }
    app.save(accounts);
    const attachments = app.findCollectionByNameOrId("attachments");
    if (!attachments.fields.getByName("cloud_index")) {
      attachments.fields.add(new Field({ name: "cloud_index", type: "number", onlyInt: true, min: -1 }));
    }
    app.save(attachments);
  },
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");
    accounts.fields.removeByName("cloud_managed");
    app.save(accounts);
    const attachments = app.findCollectionByNameOrId("attachments");
    attachments.fields.removeByName("cloud_index");
    app.save(attachments);
  }
);
