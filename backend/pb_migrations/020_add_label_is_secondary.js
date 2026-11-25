/// <reference path="../pb_data/types.d.ts" />

// Ajoute le flag is_secondary sur la collection labels.
// Un label "secondaire" exclut ses messages de la boite de reception
// (inbox = messages sans label secondaire). L'utilisateur peut basculer
// ce flag depuis la sidebar (clic sur la pastille couleur du label).
//
// Initialisation : les labels existants dont le nom (normalise) matche
// une categorie reconnue comme secondaire par defaut sont marques.

migrate(
  (app) => {
    const labels = app.findCollectionByNameOrId("labels");
    labels.fields.add(new Field({ name: "is_secondary", type: "bool" }));
    app.save(labels);

    // Init : marquer les labels existants matchant les categories par defaut.
    const DEFAULTS = [
      "newsletter", "newsletters",
      "promotion", "promotions",
      "notification", "notifications",
      "reseaux sociaux", "reseau social",
      "marketing", "publicite",
    ];
    const placeholders = DEFAULTS.map((_, i) => "{:n" + i + "}").join(",");
    const bindings = {};
    DEFAULTS.forEach((v, i) => { bindings["n" + i] = v; });

    try {
      app.db()
        .newQuery(
          "UPDATE labels SET is_secondary = TRUE " +
          "WHERE LOWER(name) IN (" + placeholders + ")"
        )
        .bind(bindings)
        .execute();
    } catch (e) {
      console.log("020_add_label_is_secondary init failed: " + e);
    }
  },

  (app) => {
    const labels = app.findCollectionByNameOrId("labels");
    labels.fields.removeByName("is_secondary");
    app.save(labels);
  }
);
