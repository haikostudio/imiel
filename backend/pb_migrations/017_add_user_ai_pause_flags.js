/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new Field({ name: "sync_paused", type: "bool" }));
    users.fields.add(new Field({ name: "ai_embeddings_paused", type: "bool" }));
    users.fields.add(new Field({ name: "ai_categorize_paused", type: "bool" }));
    app.save(users);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("sync_paused");
    users.fields.removeByName("ai_embeddings_paused");
    users.fields.removeByName("ai_categorize_paused");
    app.save(users);
  }
);
