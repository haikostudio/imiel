/// <reference path="../pb_data/types.d.ts" />

// auto-save.js
// Upsert draft messages (auto-save from composer).

// ---------------------------------------------------------------------------
// API: auto-save draft
// ---------------------------------------------------------------------------
routerAdd("POST", "/api/mail/auto-save", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const body = e.requestInfo().body;
  const accountId = body.account_id;
  const draftId = body.draft_id;

  if (!accountId) {
    throw new BadRequestError("account_id is required");
  }

  // Verify account ownership
  const account = $app.findRecordById("accounts", accountId);
  if (account.get("user") !== authRecord.id) {
    throw new ForbiddenError("Not your account");
  }

  let record;
  let isNew = false;

  // Upsert: update existing draft or create new one
  if (draftId) {
    try {
      record = $app.findRecordById("messages", draftId);
      // Allow switching account if both belong to the same user
      if (record.get("account") !== accountId) {
        var oldAccount = $app.findRecordById("accounts", record.get("account"));
        if (oldAccount.get("user") !== authRecord.id) {
          throw new ForbiddenError("Draft does not belong to this account");
        }
        // Re-assign draft to new account + its drafts folder
        record.set("account", accountId);
        try {
          var newDraftsFolders = $app.findRecordsByFilter(
            "folders",
            'account = {:accountId} && type = "drafts"',
            "",
            1,
            0,
            { accountId: accountId }
          );
          if (newDraftsFolders.length > 0) {
            record.set("folder", newDraftsFolders[0].id);
          }
        } catch (_) {}
      }
      // Verify it's actually a draft
      if (!record.get("is_draft")) {
        throw new BadRequestError("Message is not a draft");
      }
    } catch (err) {
      // PocketBase 0.25 formule le message de findRecordById en "wasn't found"
      // (ex: "The requested resource wasn't found."), pas "not found" : sans ce
      // second motif, un draft_id perime (brouillon deja supprime/envoye ailleurs)
      // rate la detection ci-dessous et fait remonter un 404 brut au client au
      // lieu de basculer sur la dedup/creation -> "Envoyer" casse avec l'erreur
      // generique PocketBase "The requested resource wasn't found."
      // Sous JSVM, findRecordById leve l'erreur Go brute "sql: no rows in
      // result set" (le texte "wasn't found" n'apparait qu'une fois convertie
      // en reponse HTTP) : c'est CE motif qui signale un draft_id fantome.
      var errStr = String(err);
      if (
        errStr.includes("no rows in result set") ||
        errStr.includes("not found") ||
        errStr.includes("wasn't found") ||
        errStr.includes("couldn't find")
      ) {
        record = null;
      } else {
        throw err;
      }
    }
  }

  // Dedup serveur : si aucun draft_id explicite n'a resolu un brouillon, ne PAS
  // creer aveuglement un nouveau brouillon. Reutiliser un brouillon existant du
  // meme compte dont le SUJET ET les DESTINATAIRES correspondent. Sans ca, chaque
  // reouverture d'une zone de reponse (badge thread non retrouve, brouillon
  // detache, multi-fenetres) recree un doublon -> dizaines de "Re: ..." identiques.
  //
  // Helper reutilise (1) avant creation et (2) en rattrapage si l'index unique
  // de la base rejette un insert concurrent (course : plusieurs POST simultanes).
  // Signature des destinataires : ensemble d'adresses (To) normalisees + triees.
  function recipientSig(addrs) {
    // Un champ json lu sur un record (record.get) arrive en JSONRaw (octets),
    // pas en tableau : sans ce decodage, la signature d'un brouillon existant
    // valait toujours "" -> dedup jamais trouvee -> collision avec l'index
    // unique idx_msg_draft_dedup a chaque sauvegarde concurrente.
    // (JSONRaw passe Array.isArray : on le reconnait a ses elements numeriques.)
    if (addrs && (!Array.isArray(addrs) || typeof addrs[0] === "number")) {
      try {
        addrs = JSON.parse(toString(addrs));
      } catch (_) {
        addrs = [];
      }
    }
    if (!addrs || !addrs.length) return "";
    var list = [];
    for (var i = 0; i < addrs.length; i++) {
      var a = addrs[i];
      var addr = a && a.address ? String(a.address).trim().toLowerCase() : "";
      if (addr) list.push(addr);
    }
    list.sort();
    return list.join(",");
  }
  function findDuplicateDraft() {
    var sub = (body.subject !== undefined ? (body.subject || "") : "").trim();
    var sig = recipientSig(body.to);
    // On ne deduplique que si la cle est exploitable (sujet OU destinataire non
    // vide) pour ne pas fusionner tous les brouillons vierges entre eux.
    if (!sub && !sig) return null;
    try {
      var candidates = $app.findRecordsByFilter(
        "messages",
        "account = {:accountId} && is_draft = true && subject = {:subject}",
        "-auto_saved_at",
        50,
        0,
        { accountId: accountId, subject: sub }
      );
      for (var c = 0; c < candidates.length; c++) {
        if (recipientSig(candidates[c].get("to_addresses")) === sig) {
          return candidates[c];
        }
      }
    } catch (_) {}
    return null;
  }

  function recordExists(id) {
    try {
      $app.findRecordById("messages", id);
      return true;
    } catch (_) {
      return false;
    }
  }

  if (!record) {
    record = findDuplicateDraft();
  }

  if (!record) {
    const collection = $app.findCollectionByNameOrId("messages");
    record = new Record(collection);
    record.set("account", accountId);
    record.set("is_draft", true);
    record.set("is_read", true);
    isNew = true;
  }

  // Update draft fields
  if (body.to !== undefined) {
    record.set("to_addresses", body.to || []);
  }
  if (body.cc !== undefined) {
    record.set("cc_addresses", body.cc || []);
  }
  if (body.bcc !== undefined) {
    record.set("bcc_addresses", body.bcc || []);
  }
  if (body.subject !== undefined) {
    record.set("subject", body.subject || "");
  }
  if (body.text_body !== undefined) {
    record.set("text_body", body.text_body || "");
  }
  if (body.html_body !== undefined) {
    record.set("html_body", body.html_body || "");
  }
  if (body.in_reply_to !== undefined) {
    record.set("in_reply_to", body.in_reply_to || "");
  }
  if (body.references !== undefined) {
    record.set("references", body.references || []);
  }
  if (body.draft_reply_to !== undefined) {
    record.set("draft_reply_to", body.draft_reply_to || "");
  }
  if (body.priority !== undefined) {
    record.set("priority", body.priority || "normal");
  }
  if (body.thread_id !== undefined) {
    record.set("thread_id", body.thread_id || "");
  }

  // Filet de securite : un brouillon de reponse sans thread_id explicite herite
  // du thread_id du message parent (retrouve par son Message-ID via in_reply_to
  // / draft_reply_to). Sans ca le brouillon est detache de la conversation
  // (introuvable par la vue thread et le badge brouillon de la liste).
  if (!record.get("thread_id")) {
    var parentMid = body.in_reply_to || body.draft_reply_to || "";
    if (parentMid) {
      try {
        var parents = $app.findRecordsByFilter(
          "messages",
          "message_id = {:mid} && is_draft = false",
          "-date",
          1,
          0,
          { mid: parentMid }
        );
        if (parents.length > 0 && parents[0].get("thread_id")) {
          record.set("thread_id", parents[0].get("thread_id"));
        }
      } catch (_) {}
    }
  }

  // Set from address
  record.set("from_address", {
    name: account.get("display_name") || "",
    address: account.get("email"),
  });

  // Auto-save timestamp + date (used for sorting in message list)
  var now = new Date().toISOString();
  record.set("auto_saved_at", now);
  record.set("date", now);

  // Assign to drafts folder if new
  if (isNew) {
    try {
      const draftsFolders = $app.findRecordsByFilter(
        "folders",
        'account = {:accountId} && type = "drafts"',
        "",
        1,
        0,
        { accountId: accountId }
      );
      if (draftsFolders.length > 0) {
        record.set("folder", draftsFolders[0].id);
      }
    } catch (_) {}
  }

  try {
    $app.save(record);
  } catch (saveErr) {
    var msg = String(saveErr);
    // L'index unique idx_msg_draft_dedup remonte en erreur de validation
    // ("account: Value must be unique; subject: ...") et non en "UNIQUE".
    var isUnique =
      msg.indexOf("must be unique") !== -1 ||
      msg.indexOf("UNIQUE") !== -1 ||
      msg.indexOf("constraint failed") !== -1 ||
      msg.indexOf("idx_msg_draft_dedup") !== -1;
    if (isNew && isUnique) {
      // Course concurrente perdue : un autre POST a deja cree CE brouillon
      // (meme compte/thread/sujet/destinataires) et l'index unique partiel a
      // rejete notre insert. On reutilise le gagnant -> aucun doublon cree.
      var winner = findDuplicateDraft();
      if (winner) {
        record = winner;
        isNew = false;
      } else {
        throw saveErr;
      }
    } else if (record.id && recordExists(record.id)) {
      // PB 0.25: after-create hooks may fail but record is still persisted.
      // L'id d'un nouveau record est pre-genere AVANT l'insert : on verifie
      // qu'il existe vraiment, sinon on renverrait un draft_id fantome qui fait
      // echouer toutes les sauvegardes et l'envoi suivants.
      console.log("auto-save: save threw but record persisted (" + record.id + "): " + saveErr);
    } else {
      throw saveErr;
    }
  }

  return e.json(200, {
    status: isNew ? "created" : "updated",
    draft_id: record.id,
    auto_saved_at: record.get("auto_saved_at"),
  });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: discard draft
// ---------------------------------------------------------------------------
routerAdd("DELETE", "/api/mail/draft/{draftId}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const draftId = e.request.pathValue("draftId");
  if (!draftId) {
    throw new BadRequestError("draftId is required");
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

  $app.delete(record);

  return e.json(200, { status: "deleted" });
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// API: list drafts for an account
// ---------------------------------------------------------------------------
routerAdd("GET", "/api/mail/drafts/{accountId}", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const accountId = e.request.pathValue("accountId");
  if (!accountId) {
    throw new BadRequestError("accountId is required");
  }

  const account = $app.findRecordById("accounts", accountId);
  if (account.get("user") !== authRecord.id) {
    throw new ForbiddenError("Not your account");
  }

  const drafts = $app.findRecordsByFilter(
    "messages",
    "account = {:accountId} && is_draft = true",
    "-auto_saved_at",
    100,
    0,
    { accountId: accountId }
  );

  const result = [];
  for (const draft of drafts) {
    result.push({
      id: draft.id,
      to: draft.get("to_addresses"),
      subject: draft.get("subject"),
      snippet: (draft.get("text_body") || "").substring(0, 100),
      auto_saved_at: draft.get("auto_saved_at"),
      draft_reply_to: draft.get("draft_reply_to"),
    });
  }

  return e.json(200, { drafts: result });
}, $apis.requireAuth());
