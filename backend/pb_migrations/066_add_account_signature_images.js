/// <reference path="../pb_data/types.d.ts" />

// Images des signatures (logo, photo) : stockees sur le COMPTE, dans un champ
// fichier NON protege. Le HTML de la signature (accounts.signature) les
// reference par leur URL publique absolue
// (https://<app>/api/files/accounts/<id>/<fichier>) : chez le destinataire,
// l'image se charge sans jeton, dans chaque mail envoye (pas de piece jointe a
// dupliquer a chaque envoi). Ne jamais passer ce champ en "protected" : les
// signatures deja envoyees afficheraient une image cassee.
migrate(
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");
    accounts.fields.add(
      new Field({
        name: "signature_images",
        type: "file",
        maxSelect: 40,
        maxSize: 2097152,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"],
        protected: false,
      })
    );
    app.save(accounts);
  },
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");
    accounts.fields.removeByName("signature_images");
    app.save(accounts);
  }
);
