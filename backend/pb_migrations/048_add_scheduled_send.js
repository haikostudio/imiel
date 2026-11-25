/// <reference path="../pb_data/types.d.ts" />

// scheduled_at : date/heure d'envoi programme d'un brouillon (fonctionnalite
// "envoyer plus tard"). Le brouillon reste is_draft=true tant que la date n'est
// pas atteinte ; le cron `mail_scheduled_send` (mail-schedule.pb.js) le repere
// (is_draft=true && scheduled_at != "" && scheduled_at <= now) et le pousse au
// worker /send. Vide = envoi immediat classique.
//
// IMPORTANT : le listing (GET /api/mail/list) force `INDEXED BY idx_msg_list_cover`
// (index COUVRANT, migration 036). scheduled_at etant projete par le SELECT, on
// l'AJOUTE a ce couvrant, sinon chaque ligne de brouillon retombe en fetch de
// ligne (corps ~61 Ko) et la liste redevient lente a froid.

var COVER_OLD =
  "CREATE INDEX `idx_msg_list_cover` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `thread_id`, `message_id`, " +
  "`in_reply_to`, `references`, `from_address`, `to_addresses`, `cc_addresses`, " +
  "`subject`, `snippet`, `is_read`, `is_starred`, `is_answered`, `is_sent`, " +
  "`has_attachments`, `priority`, `uid`, `labels`, `spam_score`, `spam_action`)";

var COVER_NEW =
  "CREATE INDEX `idx_msg_list_cover` ON `messages` " +
  "(`folder`, `is_draft`, `date`, `id`, `account`, `thread_id`, `message_id`, " +
  "`in_reply_to`, `references`, `from_address`, `to_addresses`, `cc_addresses`, " +
  "`subject`, `snippet`, `is_read`, `is_starred`, `is_answered`, `is_sent`, " +
  "`has_attachments`, `priority`, `uid`, `labels`, `spam_score`, `spam_action`, " +
  "`scheduled_at`)";

// Scan du cron (brouillons programmes dus).
var SCHED_IDX =
  "CREATE INDEX `idx_msg_scheduled` ON `messages` (`is_draft`, `scheduled_at`)";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new Field({ name: "scheduled_at", type: "date" }));

    messages.indexes = messages.indexes.filter((i) => i !== COVER_OLD);
    if (!messages.indexes.includes(COVER_NEW)) messages.indexes.push(COVER_NEW);
    if (!messages.indexes.includes(SCHED_IDX)) messages.indexes.push(SCHED_IDX);

    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.indexes = messages.indexes.filter(
      (i) => i !== COVER_NEW && i !== SCHED_IDX
    );
    if (!messages.indexes.includes(COVER_OLD)) messages.indexes.push(COVER_OLD);
    messages.fields.removeByName("scheduled_at");
    app.save(messages);
  }
);
