/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");

    accounts.fields.add(new Field({
      name: "color",
      type: "text",
      max: 7,
    }));

    app.save(accounts);
  },

  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");
    accounts.fields.removeByName("color");
    app.save(accounts);
  }
);
