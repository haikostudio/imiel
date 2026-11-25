/// <reference path="../pb_data/types.d.ts" />

// notifications.pb.js
// Enregistrement des push tokens + preservation du broadcast realtime.
// L'envoi des notifications push est pilote par le mail-worker (voir note
// au-dessus du hook ci-dessous).

// ---------------------------------------------------------------------------
// Hook: after new message creation
// ---------------------------------------------------------------------------
// NOTE : l'envoi de la notification push N'EST PLUS fait ici. Il est pilote par
// le mail-worker (imap.ts/pop3.ts) APRES classification spam + categorisation,
// pour ne notifier QUE les mails reellement visibles dans l'inbox (pas le spam,
// pas les mails labellises secondaire-uniquement comme Newsletter/Promotion/
// Notification, masques de l'inbox par exclude_secondary). Notifier ici, a la
// creation du record, declenchait des push pour des mails qui disparaissaient
// ensuite de la boite (et faisait doublon avec le worker).
//
// Ce hook reste neanmoins necessaire : en PB 0.25, le broadcaster realtime SSE
// natif tourne en DERNIER de la chaine onRecordAfterCreateSuccess. S'il manque
// un e.next() sur un handler "messages", la chaine s'arrete et AUCUN event SSE
// n'est emis pour la collection -> plus de mise a jour live de la liste. On
// garde donc ce handler avec un e.next() pour preserver la diffusion realtime.
onRecordAfterCreateSuccess((e) => {
  e.next();
}, "messages");

// ---------------------------------------------------------------------------
// API: register push token
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/push/register", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;

  if (!body.endpoint || !body.p256dh || !body.auth_key) {
    throw new BadRequestError("endpoint, p256dh, and auth_key are required");
  }

  // Nettoyage anti-double-push : quand un appareil se re-abonne (ex. reinstall
  // du PWA iOS), le push service delivre un NOUVEL endpoint alors que l'ancien
  // reste valide chez Apple/FCM. Sans nettoyage, les deux endpoints restent
  // enregistres et l'utilisateur recoit chaque notification DEUX fois (en
  // differe). L'envoi (mail-worker push.ts) ne filtre pas is_active -> on
  // SUPPRIME les tokens du meme user + meme appareil (device_name) dont
  // l'endpoint differe. Compromis assume : deux appareils de meme modele et
  // meme version d'OS partagent le meme UA -> le second re-enregistre au
  // prochain lancement de l'app (idempotent).
  const deviceName = body.device_name || "";
  if (deviceName) {
    try {
      const stale = $app.findRecordsByFilter(
        "push_tokens",
        "user = {:user} && device_name = {:dev} && endpoint != {:endpoint}",
        "",
        50,
        0,
        { user: authRecord.id, dev: deviceName, endpoint: body.endpoint }
      );
      for (let i = 0; i < stale.length; i++) {
        $app.delete(stale[i]);
      }
    } catch (_) {}
  }

  // Check if token already exists (upsert)
  let existing;
  try {
    const records = $app.findRecordsByFilter(
      "push_tokens",
      "endpoint = {:endpoint}",
      "",
      1,
      0,
      { endpoint: body.endpoint }
    );
    if (records.length > 0) {
      existing = records[0];
    }
  } catch (_) {}

  if (existing) {
    existing.set("user", authRecord.id);
    existing.set("p256dh", body.p256dh);
    existing.set("auth_key", body.auth_key);
    existing.set("device_name", body.device_name || "");
    existing.set("is_active", true);
    $app.save(existing);
    return e.json(200, { status: "updated", id: existing.id });
  }

  const collection = $app.findCollectionByNameOrId("push_tokens");
  const record = new Record(collection);
  record.set("user", authRecord.id);
  record.set("endpoint", body.endpoint);
  record.set("p256dh", body.p256dh);
  record.set("auth_key", body.auth_key);
  record.set("device_name", body.device_name || "");
  record.set("is_active", true);
  $app.save(record);

  return e.json(200, { status: "registered", id: record.id });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: unregister push token
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/push/unregister", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;

  if (!body.endpoint) {
    throw new BadRequestError("endpoint is required");
  }

  try {
    const records = $app.findRecordsByFilter(
      "push_tokens",
      "endpoint = {:endpoint} && user = {:userId}",
      "",
      1,
      0,
      { endpoint: body.endpoint, userId: authRecord.id }
    );
    if (records.length > 0) {
      $app.delete(records[0]);
    }
  } catch (_) {}

  return e.json(200, { status: "unregistered" });
}, $apis.requireAuth());
