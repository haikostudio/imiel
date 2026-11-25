/// <reference path="../pb_data/types.d.ts" />

// mail-schedule.js
// Envoi programme ("envoyer plus tard") :
//  - POST /api/mail/schedule : pose / met a jour / annule la date d'envoi d'un
//    brouillon (champ messages.scheduled_at, migration 048).
//  - cron mail_scheduled_send (1 min) : repere les brouillons dus
//    (is_draft=true && scheduled_at != "" && scheduled_at <= now) et les pousse
//    au worker /send (meme chemin que l'envoi manuel : is_draft=false, is_sent,
//    folder=sent, thread_id). scheduled_at est efface apres envoi reussi.

var MAIL_WORKER_URL = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

// ---------------------------------------------------------------------------
// API: programmer / reprogrammer / annuler l'envoi d'un brouillon
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/schedule", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;
  const draftId = body.draft_id;
  // scheduled_at : ISO string pour programmer, "" (ou null) pour annuler.
  const scheduledAt = body.scheduled_at;

  if (!draftId) {
    throw new BadRequestError("draft_id is required");
  }

  const record = $app.findRecordById("messages", draftId);

  // Verify ownership
  const account = $app.findRecordById("accounts", record.get("account"));
  if (account.get("user") !== authRecord.id) {
    throw new ForbiddenError("Not your draft");
  }
  if (!record.get("is_draft")) {
    throw new BadRequestError("Message is not a draft");
  }

  if (scheduledAt) {
    // Refuser une date passee (garde-fou ; le front valide aussi).
    var when = new Date(scheduledAt);
    if (isNaN(when.getTime())) {
      throw new BadRequestError("Invalid scheduled_at");
    }
    record.set("scheduled_at", when.toISOString());
  } else {
    record.set("scheduled_at", "");
  }
  $app.save(record);

  return e.json(200, {
    status: "ok",
    draft_id: record.id,
    scheduled_at: record.get("scheduled_at"),
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// Cron: envoyer les brouillons programmes arrives a echeance (toutes les min)
// ---------------------------------------------------------------------------
cronAdd("mail_scheduled_send", "* * * * *", () => {
  // PB 0.25 : le callback cron s'execute dans un runtime isole sans acces au
  // scope top-level (MAIL_WORKER_URL). On redefinit tout ICI.
  const WORKER_URL = $os.getenv("MAIL_WORKER_URL") || "http://localhost:4001";

  var callWorkerSend = function (accountId, messageId) {
    const res = $http.send({
      url: WORKER_URL + "/send",
      method: "POST",
      body: JSON.stringify({ accountId: accountId, messageId: messageId }),
      headers: { "Content-Type": "application/json" },
      timeout: 120,
    });
    if (res.statusCode >= 400) {
      throw new Error("mail-worker /send error " + res.statusCode + ": " + res.raw);
    }
    return res.json;
  };

  try {
    // PIEGE PB : les datetime sont compares comme des CHAINES au format ESPACE
    // "YYYY-MM-DD HH:MM:SS.sssZ". Un toISOString() (avec 'T') exclut a tort les
    // bornes -> on remplace le 'T' par un espace pour la comparaison du filtre.
    var nowFilter = new Date().toISOString().replace("T", " ");

    var due = $app.findRecordsByFilter(
      "messages",
      'is_draft = true && scheduled_at != "" && scheduled_at <= {:now}',
      "scheduled_at",
      50,
      0,
      { now: nowFilter }
    );

    for (var i = 0; i < due.length; i++) {
      var draft = due[i];
      var accountId = draft.get("account");
      try {
        callWorkerSend(accountId, draft.id);
        // Le worker a bascule is_draft=false / is_sent=true. On efface
        // scheduled_at (recharge frais) pour garder l'etat propre (le badge
        // "programme" de la liste s'appuie dessus).
        try {
          var sent = $app.findRecordById("messages", draft.id);
          sent.set("scheduled_at", "");
          $app.save(sent);
        } catch (_) {}
        console.log("[schedule] sent scheduled draft " + draft.id);
      } catch (err) {
        // Erreur non bloquante : on retentera au tick suivant.
        console.log("[schedule] failed to send draft " + draft.id + ": " + err);
      }
    }
  } catch (err) {
    console.log("[schedule] cron error: " + err);
  }
});
