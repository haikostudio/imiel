/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // --- api_keys : cles d'acces du connecteur MCP en ligne (Reglages >
    // Connectivite). Seule l'EMPREINTE sha256 est gardee (`key_hash`, cache a
    // l'API) : la cle entiere n'est rendue qu'une fois, par le worker qui la
    // cree (createRule null = worker seulement). Le proprietaire liste et
    // supprime les siennes ; une cle supprimee est refusee aussitot. ---
    const keys = new Collection({
      name: "api_keys",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: null,
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", max: 80, required: true },
        { name: "scope", type: "select", values: ["read", "full"], maxSelect: 1, required: true },
        { name: "key_hash", type: "text", max: 64, required: true, hidden: true },
        { name: "prefix", type: "text", max: 20 },
        { name: "last_used", type: "date" },
        { name: "inactive_notified_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys (key_hash)",
        "CREATE INDEX idx_api_keys_user ON api_keys (user)",
      ],
    });
    app.save(keys);
  },

  (app) => {
    app.delete(app.findCollectionByNameOrId("api_keys"));
  }
);
