/// <reference path="../pb_data/types.d.ts" />

// Integration du Cerveau (memoire centrale https://memoire.example.com) :
// - cerveau_api_key : cle API par utilisateur (presence = integration active),
//   meme principe que openrouter_api_key (migr 016).
// - cerveau_paused : met en pause le push vers le Cerveau (meme principe que
//   les autres flags ai_*_paused, migr 017).
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new Field({ name: "cerveau_api_key", type: "text", max: 200 }));
    users.fields.add(new Field({ name: "cerveau_paused", type: "bool" }));
    app.save(users);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("cerveau_api_key");
    users.fields.removeByName("cerveau_paused");
    app.save(users);
  }
);
