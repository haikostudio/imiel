/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Vignettes de l'onglet "Pieces jointes" des Details de la conversation :
    // PocketBase ne fabrique une version reduite (?thumb=240x240) que pour une
    // taille DECLAREE sur le champ fichier ; sans elle il rend l'original.
    const attachments = app.findCollectionByNameOrId("attachments");
    attachments.fields.getByName("file").thumbs = ["240x240"];
    app.save(attachments);
  },

  (app) => {
    const attachments = app.findCollectionByNameOrId("attachments");
    attachments.fields.getByName("file").thumbs = [];
    app.save(attachments);
  }
);
