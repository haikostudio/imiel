/// <reference path="../pb_data/types.d.ts" />

// Rappels (alertes) sur les evenements de calendrier.
// - `reminders` : tableau JSON d'offsets en MINUTES avant le debut de l'event
//   (ex: [540, 180, 30] = 9h / 3h / 30min). Liste vide ou absente => le worker
//   applique les defauts [540, 180, 30].
// - `reminders_sent` : tableau JSON des offsets DEJA notifies pour cet event
//   (anti-doublon entre deux passages du cron). Reinitialise quand `start` ou
//   `reminders` change (cf. route PATCH /calendar/event/:id du worker).
// Index sur `start` pour le scan cross-user du cron de rappels.
migrate(
  (app) => {
    const events = app.findCollectionByNameOrId("calendar_events");

    events.fields.add(
      new Field({ name: "reminders", type: "json", maxSize: 2000 })
    );
    events.fields.add(
      new Field({ name: "reminders_sent", type: "json", maxSize: 2000 })
    );

    events.indexes = events.indexes.concat([
      "CREATE INDEX idx_calevents_start ON calendar_events (start)",
    ]);

    app.save(events);
  },

  (app) => {
    const events = app.findCollectionByNameOrId("calendar_events");
    events.fields.removeByName("reminders");
    events.fields.removeByName("reminders_sent");
    events.indexes = events.indexes.filter(
      (idx) => idx.indexOf("idx_calevents_start") === -1
    );
    app.save(events);
  }
);
