/// <reference path="../pb_data/types.d.ts" />

// Apparence de l'application par compte : "miel" (defaut, valeur vide comprise)
// ou "minimal" (l'apparence noir et blanc d'origine), et le fond illustre de
// l'apparence Miel. Vide = miel + vagues, donc les comptes existants passent
// en Miel sans reprise de donnees.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("design")) {
      users.fields.add(
        new Field({
          name: "design",
          type: "select",
          maxSelect: 1,
          values: ["miel", "minimal"],
        })
      );
    }
    if (!users.fields.getByName("design_background")) {
      users.fields.add(
        new Field({
          name: "design_background",
          type: "select",
          maxSelect: 1,
          values: ["vagues", "alveoles", "matin", "uni"],
        })
      );
    }
    app.save(users);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("design");
    users.fields.removeByName("design_background");
    app.save(users);
  }
);
