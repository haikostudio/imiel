/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");

    const attachments = new Collection({
      name: "attachments",
      type: "base",
      listRule: "@request.auth.id = message.account.user",
      viewRule: "@request.auth.id = message.account.user",
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "filename", type: "text", required: true, max: 500 },
        { name: "content_type", type: "text", max: 255 },
        { name: "size", type: "number", min: 0 },
        { name: "file", type: "file", maxSelect: 1, maxSize: 26214400 },
        { name: "content_id", type: "text", max: 500 },
        { name: "is_inline", type: "bool" },
      ],
      indexes: [
        "CREATE INDEX idx_attachments_message ON attachments (message)",
      ],
    });
    app.save(attachments);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("attachments"));
    } catch (_) {}
  }
);
