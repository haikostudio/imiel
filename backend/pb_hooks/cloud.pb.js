/// <reference path="../pb_data/types.d.ts" />

// cloud.pb.js — iMiel Cloud : la base LOCALE d'un appareil (ordinateur, iPhone)
// recoit ce que le serveur de transfert lit chez le fournisseur. Le client de
// synchro de l'interface (frontend/src/lib/cloud/) appelle ces routes avec la
// session de l'utilisateur local ; tout est verifie contre lui.
//
//   POST /api/cloud/boites          miroir des boites du compte (sans mot de passe)
//   GET  /api/cloud/curseurs        par dossier : UIDVALIDITY, plus petit et plus grand UID recus
//   POST /api/cloud/ingest          dossiers + mails + drapeaux + disparus d'UNE boite
//   POST /api/cloud/fiches          donnees propres a iMiel venues d'un autre appareil
//   POST /api/cloud/piece-brouillon piece jointe d'un brouillon (appareil sans releveur)
//   POST /api/cloud/gratuit         passage en version gratuite : la boite redevient relevee ici
//
// Identifiants STABLES (calcules par le serveur) : un meme mail porte le meme
// identifiant sur tous les appareils ; un mail deja present n'est jamais
// recopie.

// Outils partages : les gestionnaires de route s'executent dans des contextes
// isoles (aucune variable du haut du fichier n'y est visible) ; ils chargent
// donc cloud-outils.js avec require().

// --- Miroir des boites -------------------------------------------------------
routerAdd(
  "POST",
  "/api/cloud/boites",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var userId = e.auth.id;
    var body = e.requestInfo().body || {};
    var boites = body.boites || [];
    var col = $app.findCollectionByNameOrId("accounts");
    var gardes = {};
    var cree = 0;
    for (var i = 0; i < boites.length; i++) {
      var b = boites[i];
      if (!o.ID_RE.test(String(b.id || ""))) continue;
      gardes[b.id] = true;
      var r = o.trouver($app, "accounts", b.id);
      if (r && r.get("user") !== userId) continue;
      if (!r) {
        r = new Record(col);
        r.set("id", b.id);
        r.set("user", userId);
        r.set("protocol", "imap");
        // Champs obligatoires du schema : aucune valeur secrete n'est posee,
        // le releveur local ne touche jamais une boite cloud_managed.
        r.set("imap_password", "-");
        r.set("smtp_password", "-");
        r.set("is_active", true);
        r.set("sync_status", "idle");
        cree++;
      }
      r.set("cloud_managed", true);
      r.set("email", b.email);
      r.set("label", b.label || b.email);
      r.set("display_name", b.display_name || "");
      if (b.color) r.set("color", b.color);
      if (b.signature !== undefined) r.set("signature", b.signature || "");
      r.set("auth_type", b.auth === "oauth2" ? "oauth2" : "password");
      r.set("oauth_provider", b.oauth_provider || "");
      var im = b.imap || {};
      var sm = b.smtp || {};
      r.set("imap_host", im.host || "cloud");
      r.set("imap_port", im.port || 993);
      r.set("imap_security", im.security || "ssl");
      r.set("imap_username", b.email);
      r.set("smtp_host", sm.host || "cloud");
      r.set("smtp_port", sm.port || 587);
      r.set("smtp_security", sm.security || "starttls");
      r.set("smtp_username", b.email);
      r.set("sync_error", b.a_reconnecter ? "Boite a reconnecter dans Reglages > Comptes." : "");
      $app.save(r);
    }
    // Boites retirees du compte : leur miroir local part (cascade).
    var retire = 0;
    if (body.complet) {
      var locales = $app.findRecordsByFilter("accounts", "user = {:u} && cloud_managed = true", "", 500, 0, { u: userId });
      for (var j = 0; j < locales.length; j++) {
        if (!gardes[locales[j].id]) {
          $app.delete(locales[j]);
          retire++;
        }
      }
    }
    return e.json(200, { cree: cree, retire: retire });
  },
  $apis.requireAuth()
);

// --- Curseurs : ce que l'appareil a deja, par dossier --------------------------
routerAdd(
  "GET",
  "/api/cloud/curseurs",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var userId = e.auth.id;
    var accountId = e.request.url.query().get("account");
    o.boitePossedee($app, accountId, userId);
    var lignes = arrayOf(new DynamicModel({ path: "", v: 0, mn: 0, mx: 0, n: 0 }));
    $app
      .db()
      .newQuery(
        "SELECT f.path AS path, COALESCE(f.uid_validity, 0) AS v, COALESCE(MIN(m.uid), 0) AS mn, COALESCE(MAX(m.uid), 0) AS mx, COUNT(m.id) AS n " +
          "FROM folders f LEFT JOIN messages m ON m.folder = f.id AND m.uid > 0 AND m.is_draft = FALSE " +
          "WHERE f.account = {:a} GROUP BY f.id"
      )
      .bind({ a: accountId })
      .all(lignes);
    var out = {};
    for (var i = 0; i < lignes.length; i++) {
      var l = lignes[i];
      if (!l.v) continue;
      out[l.path] = { v: l.v, u: l.mx, min: l.mn, n: l.n };
    }
    return e.json(200, { curseurs: out });
  },
  $apis.requireAuth()
);

// --- Ingestion d'une synchro --------------------------------------------------
routerAdd(
  "POST",
  "/api/cloud/ingest",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var userId = e.auth.id;
    var body = e.requestInfo().body || {};
    var accountId = String(body.boite || "");
    o.boitePossedee($app, accountId, userId);
    var dossiers = body.dossiers || [];
    var resultats = body.resultats || {};
    var bilan = { crees: 0, maj: 0, retires: 0, dossiers: 0 };
    var nouveaux = [];

    $app.runInTransaction(function (tx) {
      var colF = tx.findCollectionByNameOrId("folders");
      var colM = tx.findCollectionByNameOrId("messages");
      var colA = tx.findCollectionByNameOrId("attachments");
      var parChemin = {};

      for (var i = 0; i < dossiers.length; i++) {
        var d = dossiers[i];
        if (!o.ID_RE.test(String(d.id || ""))) continue;
        var f = o.trouver(tx, "folders", d.id);
        if (f && f.get("account") !== accountId) continue;
        if (!f) {
          f = new Record(colF);
          f.set("id", d.id);
          f.set("account", accountId);
          bilan.dossiers++;
        }
        f.set("name", d.name || d.path);
        f.set("path", d.path);
        f.set("type", d.type || "custom");
        f.set("delimiter", d.delimiter || "/");
        f.set("sort_order", d.sort_order || 0);
        var r = resultats[d.path];
        var ancienneValidite = f.get("uid_validity");
        if (r && r.v) f.set("uid_validity", r.v);
        tx.save(f);
        parChemin[d.path] = { record: f, type: d.type || "custom", ancienne: ancienneValidite };
      }

      for (var chemin in resultats) {
        var res = resultats[chemin];
        var dos = parChemin[chemin];
        if (!dos) continue;
        var folderId = dos.record.id;

        // Nouvelle UIDVALIDITY : les anciens UID ne designent plus rien.
        if (res.remise && dos.ancienne && dos.ancienne !== res.v) {
          var vieux = tx.findRecordsByFilter("messages", "folder = {:f} && is_draft = false", "", 0, 0, { f: folderId });
          for (var k = 0; k < vieux.length; k++) {
            tx.delete(vieux[k]);
            bilan.retires++;
          }
        }

        var mails = res.mails || [];
        for (var m = 0; m < mails.length; m++) {
          var x = mails[m];
          if (!o.ID_RE.test(String(x.id || ""))) continue;
          if (o.trouver(tx, "messages", x.id)) continue;
          var rec = new Record(colM);
          rec.set("id", x.id);
          rec.set("account", accountId);
          rec.set("folder", folderId);
          rec.set("uid", x.uid);
          rec.set("message_id", x.message_id || "");
          rec.set("thread_id", x.thread_id || "");
          rec.set("subject", x.subject || "");
          rec.set("from_address", x.from_address || {});
          rec.set("to_addresses", x.to_addresses || []);
          rec.set("cc_addresses", x.cc_addresses || []);
          rec.set("bcc_addresses", x.bcc_addresses || []);
          rec.set("date", x.date);
          rec.set("snippet", x.snippet || "");
          rec.set("text_body", x.text_body || "");
          rec.set("html_body", x.html_body || "");
          rec.set("is_read", !!x.is_read);
          rec.set("is_starred", !!x.is_starred);
          rec.set("is_answered", !!x.is_answered);
          rec.set("is_draft", false);
          rec.set("is_sent", dos.type === "sent");
          rec.set("has_attachments", !!x.has_attachments);
          rec.set("references", x.references || []);
          rec.set("in_reply_to", x.in_reply_to || "");
          rec.set("raw_headers", x.raw_headers || "");
          rec.set("priority", "normal");
          try {
            tx.save(rec);
          } catch (err) {
            // Meme mail deja range (course entre deux synchros) : on passe.
            continue;
          }
          bilan.crees++;
          if (dos.type === "inbox" && !x.is_read) nouveaux.push({ id: x.id, subject: x.subject, from: x.from_address });
          var pieces = x.pieces || [];
          for (var p = 0; p < pieces.length; p++) {
            var pj = pieces[p];
            var a = new Record(colA);
            if (o.ID_RE.test(String(pj.id || ""))) a.set("id", pj.id);
            a.set("message", x.id);
            a.set("filename", pj.filename || "piece-jointe");
            a.set("content_type", pj.content_type || "");
            a.set("size", pj.size || 0);
            a.set("content_id", pj.content_id || "");
            a.set("is_inline", !!pj.is_inline);
            a.set("cloud_index", pj.index);
            try {
              tx.save(a);
            } catch (_) {}
          }
        }

        // Drapeaux changes ailleurs (lu, favori, repondu).
        var drapeaux = res.drapeaux || [];
        if (drapeaux.length) {
          var parUid = {};
          for (var q = 0; q < drapeaux.length; q++) parUid[drapeaux[q].uid] = drapeaux[q];
          var minU = drapeaux[0].uid;
          var locaux = tx.findRecordsByFilter("messages", "folder = {:f} && uid >= {:min} && is_draft = false", "", 0, 0, { f: folderId, min: minU });
          for (var s = 0; s < locaux.length; s++) {
            var loc = locaux[s];
            var dr = parUid[loc.getInt("uid")];
            if (!dr) continue;
            if (loc.getBool("is_read") !== dr.lu || loc.getBool("is_starred") !== dr.favori || loc.getBool("is_answered") !== dr.repondu) {
              loc.set("is_read", dr.lu);
              loc.set("is_starred", dr.favori);
              loc.set("is_answered", dr.repondu);
              tx.save(loc);
              bilan.maj++;
            }
          }
        }

        // Mails disparus chez le fournisseur (supprimes, deplaces ailleurs).
        // Plage deja connue de l'appareil : [min, jusqua] (jamais les mails
        // qui viennent d'arriver dans ce meme lot).
        var jusqua = res.jusqua !== undefined ? res.jusqua : res.u;
        if (!res.remise && res.presents && res.min && jusqua >= res.min) {
          var presents = {};
          for (var t = 0; t < res.presents.length; t++) presents[res.presents[t]] = true;
          var plage = tx.findRecordsByFilter(
            "messages",
            "folder = {:f} && uid >= {:min} && uid <= {:max} && is_draft = false",
            "",
            0,
            0,
            { f: folderId, min: res.min, max: jusqua }
          );
          for (var w = 0; w < plage.length; w++) {
            if (!presents[plage[w].getInt("uid")]) {
              tx.delete(plage[w]);
              bilan.retires++;
            }
          }
        }
      }

      var compte = tx.findRecordById("accounts", accountId);
      compte.set("last_synced_at", new Date().toISOString());
      compte.set("sync_status", "idle");
      compte.set("sync_error", "");
      tx.save(compte);
    });

    bilan.nouveaux = nouveaux;
    return e.json(200, bilan);
  },
  $apis.requireAuth(),
  $apis.bodyLimit(64 << 20)
);

// --- Donnees propres a iMiel venues d'un autre appareil -----------------------
routerAdd(
  "POST",
  "/api/cloud/fiches",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var userId = e.auth.id;
    var fiches = (e.requestInfo().body || {}).fiches || [];
    var bilan = { appliquees: 0, ignorees: 0 };
    for (var i = 0; i < fiches.length; i++) {
      var f = fiches[i];
      try {
        // Etiquettes posees sur un mail : seul le champ « labels » voyage.
        if (f.col === "messages") {
          var msg = $app.findRecordById("messages", f.id);
          o.boitePossedee($app, msg.get("account"), userId);
          msg.set("labels", f.labels || []);
          if (f.importance) msg.set("importance", f.importance);
          $app.save(msg);
          bilan.appliquees++;
          continue;
        }
        var champ = o.FICHES[f.col];
        if (!champ || !o.ID_RE.test(String((f.fiche || {}).id || f.id || ""))) {
          bilan.ignorees++;
          continue;
        }
        var id = (f.fiche || {}).id || f.id;
        var r = o.trouver($app, f.col, id);
        if (r && r.get(champ) !== userId) {
          bilan.ignorees++;
          continue;
        }
        if (f.action === "suppr") {
          if (r) $app.delete(r);
          bilan.appliquees++;
          continue;
        }
        if (!r) {
          r = new Record($app.findCollectionByNameOrId(f.col));
          r.set("id", id);
        }
        var donnees = f.fiche || {};
        for (var k in donnees) {
          if (k === "id" || k === "created" || k === "updated" || k === "collectionId" || k === "collectionName" || k === "expand") continue;
          r.set(k, donnees[k]);
        }
        r.set(champ, userId);
        $app.save(r);
        bilan.appliquees++;
      } catch (err) {
        bilan.ignorees++;
      }
    }
    return e.json(200, bilan);
  },
  $apis.requireAuth(),
  $apis.bodyLimit(16 << 20)
);

// --- Piece jointe d'un brouillon (iPhone, navigateur : pas de releveur) --------
routerAdd(
  "POST",
  "/api/cloud/piece-brouillon",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var userId = e.auth.id;
    var info = e.requestInfo();
    var messageId = String((info.body || {}).messageId || "");
    var msg = $app.findRecordById("messages", messageId);
    o.boitePossedee($app, msg.get("account"), userId);
    if (!msg.getBool("is_draft")) throw new BadRequestError("Ce mail n'est pas un brouillon.");
    var fichiers = e.findUploadedFiles("files");
    var inline = String((info.body || {}).inline || "") === "1";
    var col = $app.findCollectionByNameOrId("attachments");
    var out = [];
    for (var i = 0; i < fichiers.length; i++) {
      var a = new Record(col);
      a.set("message", messageId);
      a.set("filename", fichiers[i].originalName);
      a.set("size", fichiers[i].size);
      a.set("file", fichiers[i]);
      a.set("is_inline", inline);
      if (inline) a.set("content_id", $security.randomString(16) + "@imiel");
      $app.save(a);
      out.push({ id: a.id, filename: a.get("filename"), size: a.get("size"), file: a.get("file"), content_id: a.get("content_id"), is_inline: inline });
    }
    msg.set("has_attachments", true);
    $app.save(msg);
    return e.json(200, { success: true, attachments: out });
  },
  $apis.requireAuth(),
  $apis.bodyLimit(30 << 20)
);

routerAdd(
  "DELETE",
  "/api/cloud/piece-brouillon/{id}",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var a = $app.findRecordById("attachments", e.request.pathValue("id"));
    var msg = $app.findRecordById("messages", a.get("message"));
    o.boitePossedee($app, msg.get("account"), e.auth.id);
    if (!msg.getBool("is_draft")) throw new BadRequestError("Ce mail n'est pas un brouillon.");
    $app.delete(a);
    return e.json(200, { success: true });
  },
  $apis.requireAuth()
);

// --- Passage en version gratuite -----------------------------------------------
// Les boites reprennent leurs identifiants (donnes par le serveur a CET
// ordinateur) et seront relevees ici par le releveur local.
routerAdd(
  "POST",
  "/api/cloud/gratuit",
  function (e) {
    var o = require(__hooks + "/cloud-outils.js");
    var userId = e.auth.id;
    var boites = (e.requestInfo().body || {}).boites || [];
    var bilan = { reprises: 0, a_reconnecter: [] };
    for (var i = 0; i < boites.length; i++) {
      var b = boites[i];
      var r = o.trouver($app, "accounts", b.id);
      if (!r || r.get("user") !== userId) continue;
      if (b.reconnecter_ailleurs || !b.imap || !b.imap.password) {
        // Gmail / Outlook relies par le serveur : la connexion appartient au
        // serveur, la boite se reconnecte ici (mot de passe d'application).
        r.set("is_active", false);
        r.set("sync_error", "Reconnectez cette boite (Reglages > Comptes).");
        bilan.a_reconnecter.push(b.email);
      } else {
        r.set("imap_host", b.imap.host);
        r.set("imap_port", b.imap.port);
        r.set("imap_security", b.imap.security);
        r.set("imap_username", b.imap.username || b.email);
        r.set("imap_password", b.imap.password);
        r.set("smtp_host", b.smtp.host);
        r.set("smtp_port", b.smtp.port);
        r.set("smtp_security", b.smtp.security);
        r.set("smtp_username", b.smtp.username || b.email);
        r.set("smtp_password", b.smtp.password);
        r.set("auth_type", "password");
        r.set("is_active", true);
        r.set("sync_error", "");
        bilan.reprises++;
      }
      r.set("cloud_managed", false);
      $app.save(r);
    }
    return e.json(200, bilan);
  },
  $apis.requireAuth()
);
