/// <reference path="../pb_data/types.d.ts" />

// Invitations d'agenda recues par mail (iMIP, .ics METHOD:REQUEST) ou par la
// synchro Google : on garde de quoi REPONDRE a l'organisateur.
//
// - invitation_status : needs_action (a repondre, affiche en pointilles) |
//                       accepted | declined | tentative. Vide = pas une
//                       invitation (evenement local, Google a soi, booking).
// - organizer_email/name : a qui part la reponse.
// - attendee_email    : NOTRE adresse invitee exacte (la reponse iMIP doit en
//                       partir, sinon Outlook l'ignore).
// - account / message : compte qui a recu l'invitation + mail d'origine.
// - ics_sequence      : SEQUENCE de l'invitation (une mise a jour superieure
//                       remplace l'ancienne ; la reponse reprend la meme).
// - ics_recurrence_id : ligne RECURRENCE-ID brute (avec son TZID) de l'occurrence
//                       visee, reprise telle quelle dans la reponse.
migrate(
  (app) => {
    const events = app.findCollectionByNameOrId("calendar_events");
    const accounts = app.findCollectionByNameOrId("accounts");
    const messages = app.findCollectionByNameOrId("messages");
    const add = (f) => {
      if (!events.fields.getByName(f.name)) events.fields.add(new Field(f));
    };
    add({
      name: "invitation_status",
      type: "select",
      maxSelect: 1,
      values: ["needs_action", "accepted", "declined", "tentative"],
    });
    add({ name: "organizer_email", type: "text", max: 320 });
    add({ name: "organizer_name", type: "text", max: 200 });
    add({ name: "attendee_email", type: "text", max: 320 });
    add({ name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: false, maxSelect: 1 });
    add({ name: "message", type: "relation", collectionId: messages.id, cascadeDelete: false, maxSelect: 1 });
    add({ name: "ics_sequence", type: "number", onlyInt: true });
    add({ name: "ics_recurrence_id", type: "text", max: 300 });
    app.save(events);
  },
  (app) => {
    const events = app.findCollectionByNameOrId("calendar_events");
    for (const n of [
      "invitation_status",
      "organizer_email",
      "organizer_name",
      "attendee_email",
      "account",
      "message",
      "ics_sequence",
      "ics_recurrence_id",
    ]) {
      events.fields.removeByName(n);
    }
    app.save(events);
  }
);
