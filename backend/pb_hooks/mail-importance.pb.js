/// <reference path="../pb_data/types.d.ts" />

// mail-importance.pb.js
// "Changer le niveau" d'un mail (tri en trois niveaux, migration 075).
//
// POST /api/mail/importance   (session PocketBase obligatoire)
//   body: { message_id, importance: "important"|"secondary"|"low",
//           scope: "message" | "sender" }
//   - message : ce mail seulement -> importance_source = "user" (jamais ecrase
//     par l'IA) + exemple ajoute a users.importance_examples (10 derniers,
//     relus par le worker comme corrections a respecter).
//   - sender  : regle "tous les mails de cet expediteur" (importance_rules,
//     adresse exacte) + reclassement des mails existants de l'expediteur.
// L'utilisateur est celui de la SESSION (jamais lu du corps) et le message doit
// appartenir a l'un de ses comptes (MEM-7465).
//
// Ecriture en SQL direct : un save() de record relancerait tous les hooks de
// `messages` (labels, compteurs) pour un seul champ, et la table est enorme.

routerAdd("POST", "/api/mail/importance", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var userId = authRecord.id;
  var body = e.requestInfo().body || {};
  var messageId = String(body.message_id || "");
  var importance = String(body.importance || "");
  var scope = body.scope === "sender" ? "sender" : "message";
  if (!messageId) throw new BadRequestError("message_id is required");
  if (importance !== "important" && importance !== "secondary" && importance !== "low") {
    throw new BadRequestError("importance must be important, secondary or low");
  }

  var rows = arrayOf(new DynamicModel({ "id": "", "from_address": "", "subject": "", "owner": "" }));
  $app.db()
    .newQuery(
      "SELECT m.id AS id, COALESCE(m.from_address, '') AS from_address, " +
      "COALESCE(m.subject, '') AS subject, a.user AS owner " +
      "FROM messages m JOIN accounts a ON a.id = m.account WHERE m.id = {:id} LIMIT 1"
    )
    .bind({ "id": messageId })
    .all(rows);
  if (!rows.length) throw new NotFoundError("Message not found");
  if (rows[0].owner !== userId) throw new ForbiddenError("Message not owned by user");

  var from = { address: "", name: "" };
  try { from = JSON.parse(rows[0].from_address || "{}") || from; } catch (_) {}
  var address = String(from.address || "").toLowerCase().trim();

  if (scope === "message") {
    $app.db()
      .newQuery("UPDATE messages SET importance = {:imp}, importance_source = 'user' WHERE id = {:id}")
      .bind({ "imp": importance, "id": messageId })
      .execute();

    // Exemples pour l'IA : 10 dernieres corrections, la plus recente d'abord.
    try {
      var user = $app.findRecordById("users", userId);
      var examples = [];
      try {
        // getString rend le JSON brut (un get() rendrait un JSONRaw en octets).
        examples = JSON.parse(user.getString("importance_examples") || "[]") || [];
      } catch (_) { examples = []; }
      if (!Array.isArray(examples)) examples = [];
      var next = [{ from: address || String(from.name || ""), subject: String(rows[0].subject || "").slice(0, 120), importance: importance }];
      for (var i = 0; i < examples.length && next.length < 10; i++) {
        var ex = examples[i] || {};
        if (ex.from === next[0].from && ex.subject === next[0].subject) continue;
        next.push(ex);
      }
      user.set("importance_examples", next);
      $app.saveNoValidate(user);
    } catch (err) {
      console.log("mail-importance: examples not saved: " + err);
    }
    return e.json(200, { ok: true, scope: "message", importance: importance, updated: 1 });
  }

  // --- Tout l'expediteur ---------------------------------------------------
  if (!address) throw new BadRequestError("Message has no sender address");

  var existing = null;
  try {
    var found = $app.findRecordsByFilter(
      "importance_rules",
      "user = {:uid} && match_type = 'email' && match_value = {:val}",
      "",
      1,
      0,
      { uid: userId, val: address }
    );
    if (found.length > 0) existing = found[0];
  } catch (_) {}
  if (existing) {
    existing.set("importance", importance);
    $app.save(existing);
  } else {
    var coll = $app.findCollectionByNameOrId("importance_rules");
    var rec = new Record(coll);
    rec.set("user", userId);
    rec.set("match_type", "email");
    rec.set("match_value", address);
    rec.set("importance", importance);
    $app.save(rec);
  }

  // JSON stocke : "address":"x@y" -> on cherche la valeur entre guillemets
  // (evite qu'une regle pour a@b.com touche ba@b.com).
  var like = '%"' + address + '"%';
  var where =
    "account IN (SELECT id FROM accounts WHERE user = {:uid}) AND from_address LIKE {:like}";
  var countRows = arrayOf(new DynamicModel({ "cnt": 0 }));
  $app.db()
    .newQuery("SELECT COUNT(*) AS cnt FROM messages WHERE " + where)
    .bind({ "uid": userId, "like": like })
    .all(countRows);
  $app.db()
    .newQuery("UPDATE messages SET importance = {:imp}, importance_source = 'rule' WHERE " + where)
    .bind({ "imp": importance, "uid": userId, "like": like })
    .execute();

  return e.json(200, {
    ok: true,
    scope: "sender",
    importance: importance,
    sender: address,
    updated: countRows.length ? countRows[0].cnt : 0,
  });
}, $apis.requireAuth());
