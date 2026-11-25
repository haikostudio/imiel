/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new Field({
      name: "spam_score",
      type: "number",
    }));
    messages.fields.add(new Field({
      name: "spam_action",
      type: "text",
      max: 50,
    }));
    app.save(messages);
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("spam_score");
    messages.fields.removeByName("spam_action");
    app.save(messages);
  }
);
