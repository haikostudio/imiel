/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");
    const messages = app.findCollectionByNameOrId("messages");

    // --- project_links : rapprochement EXPEDITEUR -> CLIENT -> PROJET HaikoDev.
    // Une ligne = "les mails de cette adresse (ou de ce domaine) concernent le
    // projet <project_name>". C'est la SEULE porte d'entree de la detection de
    // taches : sans lien actif correspondant a l'expediteur, aucun appel LLM
    // n'est fait (discipline de cout). L'utilisateur cree/corrige ces
    // associations a la main (Reglages > Taches). `project_name` est le NOM du
    // projet : la porte publique HaikoDev le resout elle-meme. ---
    const links = new Collection({
      name: "project_links",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        // email = adresse exacte ; domain = tout le domaine (prioritaire: email)
        {
          name: "match_type",
          type: "select",
          maxSelect: 1,
          required: true,
          values: ["email", "domain"],
        },
        { name: "match_value", type: "text", max: 255, required: true },
        { name: "client_name", type: "text", max: 200 },
        { name: "project_name", type: "text", max: 200, required: true },
        { name: "is_active", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_projlink_user_value ON project_links (user, match_type, match_value)",
        "CREATE INDEX idx_projlink_user_active ON project_links (user, is_active)",
      ],
    });
    app.save(links);

    // --- task_suggestions : une PROPOSITION de tache detectee dans un mail
    // client, EN ATTENTE de la decision de l'utilisateur (envoyer vers HaikoDev
    // / refuser / modifier le titre et le texte avant envoi). Rien n'est JAMAIS
    // envoye automatiquement.
    // Anti-doublon : UNIQUE (user, thread_id) -> un fil de discussion ne peut
    // donner qu'UNE carte HaikoDev. Une fois `sent`, la trace (card_id, sent_at)
    // reste : la meme conversation ne recreera jamais une seconde carte. ---
    const suggestions = new Collection({
      name: "task_suggestions",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "message", type: "relation", collectionId: messages.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "link", type: "relation", collectionId: links.id, cascadeDelete: false, maxSelect: 1, required: false },
        { name: "thread_id", type: "text", max: 255, required: true },
        { name: "client_name", type: "text", max: 200 },
        { name: "project_name", type: "text", max: 200, required: true },
        { name: "sender_name", type: "text", max: 200 },
        { name: "sender_email", type: "text", max: 255 },
        { name: "subject", type: "text", max: 500 },
        { name: "title", type: "text", max: 200, required: true },
        { name: "description", type: "text", max: 20000 },
        { name: "message_date", type: "date" },
        // pending = a valider ; sent = carte creee dans HaikoDev ; refused =
        // ecarte par l'utilisateur ; error = refus de la porte publique
        // (projet ambigu / archive / inconnu, cle invalide) a montrer en clair.
        {
          name: "status",
          type: "select",
          maxSelect: 1,
          required: true,
          values: ["pending", "sent", "refused", "error"],
        },
        { name: "card_id", type: "text", max: 100 },
        { name: "sent_at", type: "date" },
        { name: "error", type: "text", max: 2000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_tasksugg_user_thread ON task_suggestions (user, thread_id)",
        "CREATE INDEX idx_tasksugg_user_status ON task_suggestions (user, status)",
      ],
    });
    app.save(suggestions);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("task_suggestions"));
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("project_links"));
    } catch (_) {}
  }
);
