/// <reference path="../pb_data/types.d.ts" />

// UIDVALIDITY de chaque dossier IMAP, relevee a la synchro. Avec le compte, le
// chemin du dossier et l'UID, elle forme la cle qui reconnait un meme mail
// releve par deux appareils relies par le nuage chiffre (aucun doublon apres
// une resynchronisation). Vide = pas encore relevee (anciens dossiers).
migrate(
  (app) => {
    const folders = app.findCollectionByNameOrId("folders");
    if (!folders.fields.getByName("uid_validity")) {
      folders.fields.add(new Field({ name: "uid_validity", type: "number", onlyInt: true, min: 0 }));
    }
    app.save(folders);
  },
  (app) => {
    const folders = app.findCollectionByNameOrId("folders");
    folders.fields.removeByName("uid_validity");
    app.save(folders);
  }
);
