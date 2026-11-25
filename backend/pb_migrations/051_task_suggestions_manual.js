/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("task_suggestions");

    // Une proposition creee A LA MAIN depuis un mail peut n'avoir aucun projet
    // rattache (expediteur sans association) : l'utilisateur saisit le nom du
    // projet dans le panneau avant d'envoyer. Le projet redevient obligatoire
    // au moment de l'ENVOI (verifie cote worker), pas a la creation.
    const project = col.fields.getByName("project_name");
    if (project) {
      project.required = false;
    }

    // Lien direct vers la carte creee dans HaikoDev (adresse
    // `#projet/<id>/tache/<id>`), pose a l'envoi -> repere cliquable dans la
    // conversation.
    if (!col.fields.getByName("card_url")) {
      col.fields.add(
        new Field({
          name: "card_url",
          type: "text",
          max: 500,
        })
      );
    }

    // Origine de la proposition : detectee a la reception ou demandee a la main.
    if (!col.fields.getByName("source")) {
      col.fields.add(
        new Field({
          name: "source",
          type: "select",
          maxSelect: 1,
          values: ["auto", "manual"],
        })
      );
    }

    app.save(col);
  },

  (app) => {
    const col = app.findCollectionByNameOrId("task_suggestions");
    const project = col.fields.getByName("project_name");
    if (project) {
      project.required = true;
    }
    col.fields.removeByName("card_url");
    col.fields.removeByName("source");
    app.save(col);
  }
);
