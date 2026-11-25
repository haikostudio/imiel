/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    const contacts = new Collection({
      name: "contacts",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", max: 500 },
        { name: "email", type: "text", required: true, max: 500 },
        { name: "last_contact_date", type: "date" },
        { name: "message_count", type: "number" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_contacts_user_email ON contacts (user, email)",
        "CREATE INDEX idx_contacts_user_name ON contacts (user, name)",
        "CREATE INDEX idx_contacts_user_count ON contacts (user, message_count)",
      ],
    });
    app.save(contacts);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("contacts"));
    } catch (_) {}
  }
);
