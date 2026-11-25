/// <reference path="../pb_data/types.d.ts" />

// Cle API HaikoDev saisie par l'utilisateur dans Reglages > Taches clients
// (meme principe que cerveau_api_key/openrouter_api_key) : prime sur la
// variable d'environnement HAIKODEV_API_KEY du service worker si presente.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new Field({ name: "haikodev_api_key", type: "text", max: 200 }));
    app.save(users);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("haikodev_api_key");
    app.save(users);
  }
);
