/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Add blocked_senders (JSON) to users collection
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new Field({
      name: "blocked_senders",
      type: "json",
    }));
    app.save(users);

    // Add raw_headers (text) to messages collection
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new Field({
      name: "raw_headers",
      type: "text",
    }));
    app.save(messages);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("blocked_senders");
    app.save(users);

    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("raw_headers");
    app.save(messages);
  }
);
