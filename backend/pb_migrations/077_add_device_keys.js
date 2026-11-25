/// <reference path="../pb_data/types.d.ts" />

// Application iPhone : cles d'appareil + jetons de notification APNs.
//
// device_keys : une cle par appareil (widgets, actions de notification sans
// session). AUCUN secret en base : secret = HMAC(secret serveur, "<user>:<id>:<nonce>"),
// recalcule a chaque requete signee (cf mail-worker device-keys.ts).
//   last_ts    : horodatage (ms) de la derniere requete acceptee (anti-rejeu).
//   revoked_at : cle revoquee (deconnexion, remplacement, retrait).
// Emise / revoquee par le worker uniquement (createRule/updateRule null) ;
// l'utilisateur voit et supprime ses appareils.
//
// push_tokens.platform : "web" (Web Push, defaut historique) | "apns" (iPhone).
// Pour APNs, `endpoint` = URL APNs de l'appareil (production ou sandbox) et
// p256dh/auth_key valent "-" (champs requis du Web Push, inutiles ici).
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const keys = new Collection({
      name: "device_keys",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: null,
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "key_id", type: "text", max: 64, required: true },
        { name: "nonce", type: "text", max: 64, required: true },
        { name: "platform", type: "text", max: 32 },
        { name: "device_name", type: "text", max: 200 },
        { name: "last_ts", type: "number", onlyInt: true },
        { name: "revoked_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_devkey_user_key ON device_keys (user, key_id)"],
    });
    app.save(keys);

    const tokens = app.findCollectionByNameOrId("push_tokens");
    if (!tokens.fields.getByName("platform")) {
      tokens.fields.add(new Field({ name: "platform", type: "select", maxSelect: 1, values: ["web", "apns"] }));
    }
    if (!tokens.fields.getByName("device_key")) {
      tokens.fields.add(new Field({ name: "device_key", type: "text", max: 64 }));
    }
    app.save(tokens);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("device_keys"));
    } catch (_) {}
    const tokens = app.findCollectionByNameOrId("push_tokens");
    tokens.fields.removeByName("platform");
    tokens.fields.removeByName("device_key");
    app.save(tokens);
  }
);
