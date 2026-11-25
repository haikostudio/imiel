/// <reference path="../pb_data/types.d.ts" />

// correspondents.pb.js
// Adresses auxquelles l'utilisateur a DEJA ecrit (destinataires A/Cc de ses
// mails envoyes), en SQL direct.
//
// Sert au rappel "attend une reponse" des lignes de conversation
// (frontend lib/utils/awaiting-reply.ts) : un mail recu n'attend une reponse
// que s'il vient d'un vrai correspondant. Les alertes, confirmations et
// notifications (property-alerts@, contact@banque, service@...) ne passent pas :
// on ne leur a jamais ecrit.
//
// Servi par l'index COUVRANT idx_msg_trust_sent (is_sent, account,
// to_addresses, cc_addresses ; migration 045) : aucune lecture des lignes
// volumineuses (corps inline). ~2,5k mails envoyes -> quelques ms.
//
// GET /api/mail/correspondents -> { addresses: ["a@b.fr", ...] } (minuscules)

routerAdd("GET", "/api/mail/correspondents", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var userId = authRecord.id;

  var rows = arrayOf(new DynamicModel({ "to_addresses": "", "cc_addresses": "" }));
  try {
    $app.db()
      .newQuery(
        "SELECT COALESCE(m.to_addresses, '') AS to_addresses, " +
        "  COALESCE(m.cc_addresses, '') AS cc_addresses " +
        "FROM messages m INDEXED BY idx_msg_trust_sent " +
        "JOIN accounts a ON m.account = a.id " +
        "WHERE m.is_sent = TRUE AND a.user = {:userId}"
      )
      .bind({ "userId": userId })
      .all(rows);
  } catch (err) {
    console.log("correspondents error: " + err);
    return e.json(500, { error: "correspondents_failed", detail: "" + err });
  }

  var seen = {};
  var addresses = [];
  var collect = function (raw) {
    if (!raw) return;
    var list;
    try { list = JSON.parse(raw); } catch (_) { return; }
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var addr = ("" + ((list[i] && list[i].address) || "")).toLowerCase().trim();
      if (!addr || seen[addr]) continue;
      seen[addr] = true;
      addresses.push(addr);
    }
  };
  for (var r = 0; r < rows.length; r++) {
    collect(rows[r].to_addresses);
    collect(rows[r].cc_addresses);
  }

  return e.json(200, { addresses: addresses });
}, $apis.requireAuth());
