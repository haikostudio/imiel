/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const folders = app.findCollectionByNameOrId("folders");

    folders.fields.add(new Field({
      name: "delimiter",
      type: "text",
      max: 10,
    }));

    folders.fields.add(new Field({
      name: "last_uid",
      type: "number",
      min: 0,
    }));

    app.save(folders);
  },

  (app) => {
    const folders = app.findCollectionByNameOrId("folders");
    folders.fields.removeByName("delimiter");
    folders.fields.removeByName("last_uid");
    app.save(folders);
  }
);
