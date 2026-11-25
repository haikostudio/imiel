/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Recapitulatif du matin (mail-worker daily-digest.ts).
    // - daily_digest_disabled : stocke l'INVERSE de l'interrupteur. Un bool
    //   PocketBase vaut false par defaut : le recapitulatif est ainsi ACTIF
    //   pour tous les comptes existants et nouveaux, sans rattrapage.
    // - daily_digest_day : jour Paris (AAAA-MM-JJ) du dernier recapitulatif
    //   envoye, ecrit AVANT le depot pour ne JAMAIS l'envoyer deux fois.
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("daily_digest_disabled")) {
      users.fields.add(new Field({ name: "daily_digest_disabled", type: "bool" }));
    }
    if (!users.fields.getByName("daily_digest_day")) {
      users.fields.add(new Field({ name: "daily_digest_day", type: "text", max: 10 }));
    }
    app.save(users);
  },

  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("daily_digest_disabled");
    users.fields.removeByName("daily_digest_day");
    app.save(users);
  }
);
