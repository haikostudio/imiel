/// <reference path="../pb_data/types.d.ts" />

migrate(
  // -- Up --
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    const newFields = [
      { name: "sidebar_width", type: "number", min: 0, max: 100 },
      { name: "folder_nav_size", type: "number", min: 0, max: 100 },
      { name: "mail_list_size", type: "number", min: 0, max: 100 },
    ];

    for (const field of newFields) {
      users.fields.add(new Field(field));
    }

    app.save(users);
  },

  // -- Rollback --
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const fieldsToRemove = ["sidebar_width", "folder_nav_size", "mail_list_size"];
    for (const name of fieldsToRemove) {
      users.fields.removeByName(name);
    }
    app.save(users);
  }
);
