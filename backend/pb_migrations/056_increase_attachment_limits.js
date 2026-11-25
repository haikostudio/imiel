/// <reference path="../pb_data/types.d.ts" />

// Les pieces jointes email (compose) et les medias WhatsApp rapatries etaient
// plafonnes a 25 Mo (heritage d'un reflexe "hebergeur mutualise") alors que
// l'app tourne sur un VPS propre. On porte le plafond a 2 Go, aligne sur
// ATTACHMENT_MAX_BYTES (mail-worker index.ts) et MEDIA_MAX_BYTES
// (whatsapp-media.ts).
const OLD_MAX = 26214400; // 25 Mo
const NEW_MAX = 2147483648; // 2 Go

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.getByName("attachments").maxSize = NEW_MAX;
    app.save(messages);

    const attachments = app.findCollectionByNameOrId("attachments");
    attachments.fields.getByName("file").maxSize = NEW_MAX;
    app.save(attachments);

    const wa = app.findCollectionByNameOrId("whatsapp_messages");
    const media = wa.fields.getByName("media");
    if (media) {
      media.maxSize = NEW_MAX;
      app.save(wa);
    }
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.getByName("attachments").maxSize = OLD_MAX;
    app.save(messages);

    const attachments = app.findCollectionByNameOrId("attachments");
    attachments.fields.getByName("file").maxSize = OLD_MAX;
    app.save(attachments);

    const wa = app.findCollectionByNameOrId("whatsapp_messages");
    const media = wa.fields.getByName("media");
    if (media) {
      media.maxSize = OLD_MAX;
      app.save(wa);
    }
  }
);
