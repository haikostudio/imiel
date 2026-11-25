/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(
      new Field({
        name: "ui_scale",
        type: "select",
        maxSelect: 1,
        values: ["small", "medium", "large"],
      })
    );
    app.save(users);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("ui_scale");
    app.save(users);
  }
);
