/// <reference path="../pb_data/types.d.ts" />

// Videos et documents des discussions WhatsApp.
//
// La migration 054 avait ouvert le stockage des medias (images, sons). Les
// videos et les documents s'y ajoutent : il ne manquait qu'un endroit pour
// garder le NOM D'ORIGINE du fichier. PocketBase renomme les fichiers qu'il
// stocke (suffixe aleatoire anti-collision) : sans ce champ, un document
// s'afficherait sous un nom illisible au lieu de "Devis-2026.pdf".
migrate(
  (app) => {
    const msgs = app.findCollectionByNameOrId("whatsapp_messages");
    if (!msgs.fields.getByName("media_name")) {
      msgs.fields.add(new Field({ name: "media_name", type: "text", max: 300 }));
    }
    app.save(msgs);
  },

  (app) => {
    const msgs = app.findCollectionByNameOrId("whatsapp_messages");
    try {
      msgs.fields.removeByName("media_name");
    } catch (_) {}
    app.save(msgs);
  }
);
