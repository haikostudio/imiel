/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Etiquettes de sujet d'une newsletter (["GPT", "Securite", ...]) : posees
    // par l'IA dans le MEME appel que la synthese (ligne TAGS:), corrigeables a
    // la main, renommables/fusionnables depuis la page Statistiques.
    // `tags_done` marque une synthese deja etiquetee (le rattrapage 90 j ne
    // repasse jamais deux fois sur la meme, meme si l'IA n'a rien trouve).
    const posts = app.findCollectionByNameOrId("newsletter_posts");
    if (!posts.fields.getByName("tags")) {
      posts.fields.add(new Field({ name: "tags", type: "json", maxSize: 4000 }));
    }
    if (!posts.fields.getByName("tags_done")) {
      posts.fields.add(new Field({ name: "tags_done", type: "bool" }));
    }
    app.save(posts);

    // Resume du lundi : semaine ISO (ex. "2026-W42") du dernier resume
    // envoye, pour ne JAMAIS l'envoyer deux fois (redemarrage du worker).
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("newsletter_digest_week")) {
      users.fields.add(new Field({ name: "newsletter_digest_week", type: "text", max: 10 }));
    }
    app.save(users);
  },

  (app) => {
    const posts = app.findCollectionByNameOrId("newsletter_posts");
    posts.fields.removeByName("tags");
    posts.fields.removeByName("tags_done");
    app.save(posts);
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("newsletter_digest_week");
    app.save(users);
  }
);
