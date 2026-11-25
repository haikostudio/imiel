/// <reference path="../pb_data/types.d.ts" />

// Tri des mails en TROIS NIVEAUX (important / secondary / low).
//
// - messages.importance        : niveau du mail (vide = pas encore classe).
// - messages.importance_source : ai | rule (regle expediteur) | user (correction
//                                d'un mail) | heuristic (repli sans IA).
// - users.notify_importance    : niveaux qui declenchent une notification push
//                                (vide = important_secondary, decision utilisateur).
// - importance_rules           : "tous les mails de cet expediteur sont X"
//                                (adresse exacte ou domaine), CRUD proprietaire.
//
// INDEX : le listing (mail-list.pb.js) filtre par l'index etroit
// idx_msg_list_keys (migration 067) et projette par l'index couvrant
// idx_msg_list_cover (migration 048). `importance` est FILTREE (pastilles) et
// PROJETEE (trait de couleur) : elle entre dans les DEUX. Leur reconstruction
// lit toute la table une fois au demarrage de PocketBase (quelques minutes sur
// une grosse boite : "unhealthy" pendant ce temps est normal).

var KEYS_OLD =
  "CREATE INDEX `idx_msg_list_keys` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `is_read`, `is_starred`, " +
  "`is_sent`, `has_attachments`, `is_answered`, `priority`, `labels`, " +
  "`from_address`)";
var KEYS_NEW =
  "CREATE INDEX `idx_msg_list_keys` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `is_read`, `is_starred`, " +
  "`is_sent`, `has_attachments`, `is_answered`, `priority`, `labels`, " +
  "`from_address`, `importance`)";

var COVER_OLD =
  "CREATE INDEX `idx_msg_list_cover` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `thread_id`, `message_id`, " +
  "`in_reply_to`, `references`, `from_address`, `to_addresses`, `cc_addresses`, " +
  "`subject`, `snippet`, `is_read`, `is_starred`, `is_answered`, `is_sent`, " +
  "`has_attachments`, `priority`, `uid`, `labels`, `spam_score`, `spam_action`, " +
  "`scheduled_at`)";
var COVER_NEW =
  "CREATE INDEX `idx_msg_list_cover` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `thread_id`, `message_id`, " +
  "`in_reply_to`, `references`, `from_address`, `to_addresses`, `cc_addresses`, " +
  "`subject`, `snippet`, `is_read`, `is_starred`, `is_answered`, `is_sent`, " +
  "`has_attachments`, `priority`, `uid`, `labels`, `spam_score`, `spam_action`, " +
  "`scheduled_at`, `importance`)";

function swapIndex(list, oldDef, newDef, name) {
  var out = [];
  var done = false;
  for (var i = 0; i < list.length; i++) {
    var def = list[i];
    if (def === oldDef || def.indexOf(name + "`") !== -1 || def.indexOf(name + " ") !== -1) {
      if (!done) out.push(newDef);
      done = true;
    } else {
      out.push(def);
    }
  }
  if (!done) out.push(newDef);
  return out;
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");

    if (!messages.fields.getByName("importance")) {
      messages.fields.add(
        new Field({
          name: "importance",
          type: "select",
          maxSelect: 1,
          values: ["important", "secondary", "low"],
        })
      );
    }
    if (!messages.fields.getByName("importance_source")) {
      messages.fields.add(
        new Field({
          name: "importance_source",
          type: "select",
          maxSelect: 1,
          values: ["ai", "rule", "user", "heuristic"],
        })
      );
    }
    var idx = swapIndex(messages.indexes, KEYS_OLD, KEYS_NEW, "idx_msg_list_keys");
    idx = swapIndex(idx, COVER_OLD, COVER_NEW, "idx_msg_list_cover");
    messages.indexes = idx;
    app.save(messages);

    if (!users.fields.getByName("notify_importance")) {
      users.fields.add(
        new Field({
          name: "notify_importance",
          type: "select",
          maxSelect: 1,
          values: ["important", "important_secondary", "all"],
        })
      );
    }
    // Dernieres corrections de niveau (10 au plus) : exemples donnes a l'IA.
    if (!users.fields.getByName("importance_examples")) {
      users.fields.add(new Field({ name: "importance_examples", type: "json", maxSize: 20000 }));
    }
    app.save(users);

    const rules = new Collection({
      name: "importance_rules",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "match_type", type: "select", maxSelect: 1, required: true, values: ["email", "domain"] },
        { name: "match_value", type: "text", max: 255, required: true },
        { name: "importance", type: "select", maxSelect: 1, required: true, values: ["important", "secondary", "low"] },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_imprule_user_value ON importance_rules (user, match_type, match_value)",
      ],
    });
    app.save(rules);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("importance_rules"));
    } catch (_) {}
    const messages = app.findCollectionByNameOrId("messages");
    var idx = swapIndex(messages.indexes, KEYS_NEW, KEYS_OLD, "idx_msg_list_keys");
    idx = swapIndex(idx, COVER_NEW, COVER_OLD, "idx_msg_list_cover");
    messages.indexes = idx;
    messages.fields.removeByName("importance");
    messages.fields.removeByName("importance_source");
    app.save(messages);
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("notify_importance");
    users.fields.removeByName("importance_examples");
    app.save(users);
  }
);
