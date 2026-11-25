/// <reference path="../pb_data/types.d.ts" />

// Agendas synchronises en entier avec Google + plusieurs agendas par evenement.
//
// calendar_groups
//   - is_default  : agenda ou vont les rendez-vous lus dans les mails (et
//                   l'agenda coche d'office dans la fiche). Un seul par user,
//                   pose par defaut sur l'agenda PRINCIPAL Google (son id =
//                   l'adresse du compte), sinon rien (worker : repli local).
//   - is_primary  : agenda principal Google (jamais supprimable).
//   - access_role : role Google (owner|writer|reader|freeBusyReader) ; vide pour
//                   un agenda local. Seuls owner/writer sont proposes a l'ecriture.
//   - Doublons (user, account, google_calendar_id) fusionnes sur le plus ancien
//     (cas reel : "Chris (christ)" cree par deux synchros concurrentes le
//     2026-07-04) puis index UNIQUE partiel : un agenda Google = un seul groupe.
//
// calendar_events
//   - copy_key      : meme valeur sur toutes les copies d'un evenement range dans
//                     plusieurs agendas (une copie = un enregistrement par agenda,
//                     chacune avec sa copie Google). Vide = evenement simple.
//   - google_pushed : la copie Google a ete CREEE par nous (rattrapage, mail lu,
//                     invitation recue hors Gmail) -> une reponse d'invitation
//                     part en iMIP a l'organisateur, jamais par PATCH Google.
//   - no_push       : ne jamais pousser chez Google (invitation recue sur la
//                     boite Gmail du compte relie : Google l'ajoute lui-meme,
//                     la synchro la rattache par iCalUID).
const DEDUP_INDEX =
  "CREATE UNIQUE INDEX `idx_calgroups_user_acct_gcal` ON `calendar_groups` " +
  "(`user`, `account`, `google_calendar_id`) WHERE google_calendar_id != ''";
const COPY_INDEX = "CREATE INDEX `idx_calevents_user_copy` ON `calendar_events` (`user`, `copy_key`)";

migrate(
  (app) => {
    const groups = app.findCollectionByNameOrId("calendar_groups");
    const addG = (f) => {
      if (!groups.fields.getByName(f.name)) groups.fields.add(new Field(f));
    };
    addG({ name: "is_default", type: "bool" });
    addG({ name: "is_primary", type: "bool" });
    addG({ name: "access_role", type: "text", max: 40 });
    app.save(groups);

    const events = app.findCollectionByNameOrId("calendar_events");
    const addE = (f) => {
      if (!events.fields.getByName(f.name)) events.fields.add(new Field(f));
    };
    addE({ name: "copy_key", type: "text", max: 64 });
    addE({ name: "google_pushed", type: "bool" });
    addE({ name: "no_push", type: "bool" });
    if (!events.indexes.includes(COPY_INDEX)) events.indexes.push(COPY_INDEX);
    app.save(events);

    const db = app.db();

    // 1) Doublons d'un meme agenda Google : on garde le plus ancien groupe, on
    //    y rattache les evenements des autres (sauf ceux deja presents par
    //    google_event_id), puis on supprime les groupes en trop.
    const dupes = arrayOf(
      new DynamicModel({ user: "", account: "", gcal: "" })
    );
    db.newQuery(
      "SELECT user, account, google_calendar_id AS gcal FROM calendar_groups " +
        "WHERE google_calendar_id != '' GROUP BY user, account, google_calendar_id HAVING COUNT(*) > 1"
    ).all(dupes);
    for (const d of dupes) {
      const rows = arrayOf(new DynamicModel({ id: "" }));
      db.newQuery(
        "SELECT id FROM calendar_groups WHERE user = {:u} AND account = {:a} AND google_calendar_id = {:g} ORDER BY created ASC, id ASC"
      ).bind({ u: d.user, a: d.account, g: d.gcal }).all(rows);
      if (rows.length < 2) continue;
      const keep = rows[0].id;
      for (let i = 1; i < rows.length; i++) {
        const drop = rows[i].id;
        db.newQuery(
          "DELETE FROM calendar_events WHERE \"group\" = {:drop} AND google_event_id != '' AND google_event_id IN " +
            "(SELECT google_event_id FROM calendar_events WHERE \"group\" = {:keep})"
        ).bind({ drop: drop, keep: keep }).execute();
        db.newQuery("UPDATE calendar_events SET \"group\" = {:keep} WHERE \"group\" = {:drop}")
          .bind({ drop: drop, keep: keep })
          .execute();
        db.newQuery("DELETE FROM calendar_groups WHERE id = {:drop}").bind({ drop: drop }).execute();
        console.log("[078] groupe d'agenda en double fusionne : " + drop + " -> " + keep);
      }
    }

    // 2) Agenda principal Google = celui dont l'id est l'adresse du compte.
    db.newQuery(
      "UPDATE calendar_groups SET is_primary = 1, access_role = 'owner' WHERE google_calendar_id != '' AND " +
        "google_calendar_id = (SELECT lower(email) FROM accounts WHERE accounts.id = calendar_groups.account)"
    ).execute();

    // 3) Agenda par defaut = le principal le plus ancien, pour chaque user qui
    //    n'en a pas encore.
    db.newQuery(
      "UPDATE calendar_groups SET is_default = 1 WHERE id IN (" +
        "SELECT (SELECT g2.id FROM calendar_groups g2 WHERE g2.user = g.user AND g2.is_primary = 1 ORDER BY g2.created ASC LIMIT 1) " +
        "FROM calendar_groups g WHERE g.is_primary = 1 GROUP BY g.user " +
        "HAVING (SELECT COUNT(*) FROM calendar_groups g3 WHERE g3.user = g.user AND g3.is_default = 1) = 0)"
    ).execute();

    const groupsAgain = app.findCollectionByNameOrId("calendar_groups");
    if (!groupsAgain.indexes.includes(DEDUP_INDEX)) {
      groupsAgain.indexes.push(DEDUP_INDEX);
      app.save(groupsAgain);
    }
  },
  (app) => {
    const groups = app.findCollectionByNameOrId("calendar_groups");
    groups.indexes = groups.indexes.filter((i) => i !== DEDUP_INDEX);
    for (const n of ["is_default", "is_primary", "access_role"]) groups.fields.removeByName(n);
    app.save(groups);
    const events = app.findCollectionByNameOrId("calendar_events");
    events.indexes = events.indexes.filter((i) => i !== COPY_INDEX);
    for (const n of ["copy_key", "google_pushed", "no_push"]) events.fields.removeByName(n);
    app.save(events);
  }
);
