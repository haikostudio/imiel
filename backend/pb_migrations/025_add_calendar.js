/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const accounts = app.findCollectionByNameOrId("accounts");

    // --- calendar_groups : un groupe = une couleur (Famille, Travail, ou un
    // agenda Google mappe). Les groupes Google portent account + google_calendar_id. ---
    const groups = new Collection({
      name: "calendar_groups",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", required: true, max: 200 },
        { name: "color", type: "text", max: 20 },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: false },
        { name: "google_calendar_id", type: "text", max: 500 },
        { name: "sync_token", type: "text", max: 5000 },
        { name: "is_visible", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_calgroups_user_name ON calendar_groups (user, name)",
        "CREATE INDEX idx_calgroups_user ON calendar_groups (user)",
        "CREATE INDEX idx_calgroups_acct_gcal ON calendar_groups (account, google_calendar_id)",
      ],
    });
    app.save(groups);

    const groupsSaved = app.findCollectionByNameOrId("calendar_groups");

    // --- calendar_events : evenement local / email (.ics) / Google. Multi-jours
    // = un seul enregistrement (start/end sur plusieurs jours). ---
    const events = new Collection({
      name: "calendar_events",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "group", type: "relation", collectionId: groupsSaved.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "title", type: "text", required: true, max: 500 },
        { name: "description", type: "text", max: 20000 },
        { name: "location", type: "text", max: 500 },
        { name: "start", type: "date", required: true },
        { name: "end", type: "date", required: true },
        { name: "all_day", type: "bool" },
        { name: "source", type: "select", maxSelect: 1, values: ["local", "google", "email"] },
        { name: "google_event_id", type: "text", max: 1024 },
        { name: "google_calendar_id", type: "text", max: 500 },
        { name: "etag", type: "text", max: 500 },
        { name: "ics_uid", type: "text", max: 1024 },
        { name: "attendees", type: "json", maxSize: 50000 },
        { name: "status", type: "select", maxSelect: 1, values: ["confirmed", "tentative", "cancelled"] },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_calevents_user_start ON calendar_events (user, start)",
        "CREATE INDEX idx_calevents_group ON calendar_events (group)",
        "CREATE INDEX idx_calevents_user_gid ON calendar_events (user, google_event_id)",
        "CREATE INDEX idx_calevents_user_ics ON calendar_events (user, ics_uid)",
      ],
    });
    app.save(events);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("calendar_events"));
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("calendar_groups"));
    } catch (_) {}
  }
);
