/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // --- alert_topics : sujets que l'utilisateur veut surveiller dans ses
    // newsletters. A chaque synthese d'une NOUVELLE newsletter, le LLM dit
    // (dans le meme appel) lesquels de ces sujets sont abordes ; les sujets
    // trouves sont copies dans newsletter_posts.matched_alerts et un push
    // unique part. Entierement gere par l'utilisateur (CRUD proprietaire). ---
    const topics = new Collection({
      name: "alert_topics",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", max: 120, required: true },
        { name: "description", type: "text", max: 500 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_alert_topics_user ON alert_topics (user)"],
    });
    app.save(topics);

    // Sujets trouves dans une newsletter : [{id, name}] (copie du nom pour que
    // le bandeau survive a un renommage/suppression du sujet).
    const posts = app.findCollectionByNameOrId("newsletter_posts");
    if (!posts.fields.getByName("matched_alerts")) {
      posts.fields.add(new Field({ name: "matched_alerts", type: "json", maxSize: 20000 }));
    }
    app.save(posts);
  },

  (app) => {
    const posts = app.findCollectionByNameOrId("newsletter_posts");
    posts.fields.removeByName("matched_alerts");
    app.save(posts);
    app.delete(app.findCollectionByNameOrId("alert_topics"));
  }
);
