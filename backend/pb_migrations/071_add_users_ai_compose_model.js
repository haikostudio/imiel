/// <reference path="../pb_data/types.d.ts" />

// users.ai_compose_model : modele choisi dans le menu IA de la fenetre
// d'ecriture (ligne "Modele"). Vide = Claude Haiku 5.5 (defaut cote front,
// frontend/src/lib/ai-models.ts). Le serveur n'accepte que les ids du
// catalogue (resolveModel) : ce champ ne peut pas imposer un autre modele.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("ai_compose_model")) {
      users.fields.add(new Field({ name: "ai_compose_model", type: "text", max: 100 }));
      app.save(users);
    }
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("ai_compose_model");
    app.save(users);
  }
);
