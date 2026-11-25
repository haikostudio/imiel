/// <reference path="../pb_data/types.d.ts" />

// Add created/updated autodate fields to collections that are missing them.
// PB 0.25 base collections don't auto-add these; they must be explicit.

migrate(
  (app) => {
    var collections = ["messages", "accounts", "folders", "labels", "attachments"];

    for (var i = 0; i < collections.length; i++) {
      var col = app.findCollectionByNameOrId(collections[i]);

      if (!col.fields.getByName("created")) {
        col.fields.add(new Field({
          type: "autodate",
          name: "created",
          onCreate: true,
          onUpdate: false,
        }));
      }
      if (!col.fields.getByName("updated")) {
        col.fields.add(new Field({
          type: "autodate",
          name: "updated",
          onCreate: true,
          onUpdate: true,
        }));
      }
      app.save(col);
    }
  },

  (app) => {
    // No rollback needed - fields are additive and harmless
  }
);
