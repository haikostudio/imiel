/// <reference path="../pb_data/types.d.ts" />

// Images et notes vocales des discussions WhatsApp.
//
// Jusqu'ici un message media n'etait qu'un LIBELLE ("[image]", "[note vocale]") :
// le contenu restait sur le telephone. On stocke desormais le fichier lui-meme
// (image ou son) et, pour les vocaux, leur TRANSCRIPTION en texte.
//
// Le telechargement ne se fait pas au moment de l'ingestion (l'historique
// remonte des milliers de messages d'un coup) : le message est ecrit tout de
// suite avec `media_status = "pending"` et la reference de telechargement
// (`media_ref`, cle de dechiffrement WhatsApp), puis une boucle de fond du
// worker rapatrie les fichiers par petits lots. C'est aussi ce qui permet de
// rattraper un media a la demande, longtemps apres, sans reconnecter la session.
migrate(
  (app) => {
    const msgs = app.findCollectionByNameOrId("whatsapp_messages");

    const add = (field) => {
      if (!msgs.fields.getByName(field.name)) {
        msgs.fields.add(new Field(field));
      }
    };

    // Fichier rapatrie (image ou son). 25 Mo : plafond des envois WhatsApp.
    add({ name: "media", type: "file", maxSelect: 1, maxSize: 26214400 });
    add({ name: "media_mime", type: "text", max: 100 });
    add({ name: "media_size", type: "number", min: 0 });
    // Duree d'un vocal, en secondes.
    add({ name: "media_duration", type: "number", min: 0 });
    // pending  : a rapatrier (media_ref renseigne)
    // done     : fichier present
    // skipped  : trop vieux / trop gros pour un rapatriement automatique
    //            (le bouton "Charger" de la discussion le force au cas par cas)
    // error    : WhatsApp ne rend plus ce media (lien expire)
    // none     : message sans media
    add({
      name: "media_status",
      type: "select",
      maxSelect: 1,
      values: ["none", "pending", "done", "skipped", "error"],
    });
    // Reference de telechargement Baileys (JSON : url, directPath, mediaKey,
    // sha256...). Sans elle, un media non rapatrie serait perdu pour toujours.
    add({ name: "media_ref", type: "text", max: 4000 });
    add({ name: "media_error", type: "text", max: 500 });

    // Transcription du vocal (texte lisible dans la discussion).
    add({ name: "transcript", type: "text", max: 20000 });
    add({
      name: "transcript_status",
      type: "select",
      maxSelect: 1,
      values: ["none", "pending", "done", "error", "unavailable"],
    });
    add({ name: "transcript_error", type: "text", max: 500 });

    app.save(msgs);

    // La boucle de fond cherche "les medias a rapatrier, les plus recents
    // d'abord" : sans index, ce filtre balaie toute la table a chaque tour.
    try {
      app
        .db()
        .newQuery(
          "CREATE INDEX IF NOT EXISTS idx_wamsg_media_status ON whatsapp_messages (media_status, date)"
        )
        .execute();
      app
        .db()
        .newQuery(
          "CREATE INDEX IF NOT EXISTS idx_wamsg_transcript_status ON whatsapp_messages (transcript_status, date)"
        )
        .execute();
    } catch (_) {}
  },

  (app) => {
    const msgs = app.findCollectionByNameOrId("whatsapp_messages");
    const names = [
      "media",
      "media_mime",
      "media_size",
      "media_duration",
      "media_status",
      "media_ref",
      "media_error",
      "transcript",
      "transcript_status",
      "transcript_error",
    ];
    for (const n of names) {
      try {
        msgs.fields.removeByName(n);
      } catch (_) {}
    }
    app.save(msgs);
    try {
      app.db().newQuery("DROP INDEX IF EXISTS idx_wamsg_media_status").execute();
      app.db().newQuery("DROP INDEX IF EXISTS idx_wamsg_transcript_status").execute();
    } catch (_) {}
  }
);
