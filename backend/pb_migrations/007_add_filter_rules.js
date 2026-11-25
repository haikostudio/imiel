/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    const filterRules = new Collection({
      name: "filter_rules",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", required: true, min: 1, max: 200 },
        { name: "criteria", type: "json", required: true },
        { name: "actions", type: "json", required: true },
        { name: "is_active", type: "bool" },
        { name: "match_mode", type: "select", values: ["all", "any"] },
        { name: "source_email", type: "text", max: 500 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_filter_rules_user ON filter_rules (user)",
        "CREATE INDEX idx_filter_rules_active ON filter_rules (user, is_active)",
      ],
    });
    app.save(filterRules);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("filter_rules"));
    } catch (_) {}
  }
);
