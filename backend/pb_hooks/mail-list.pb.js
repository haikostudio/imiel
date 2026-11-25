/// <reference path="../pb_data/types.d.ts" />

// mail-list.pb.js
// Endpoint SQL-direct pour le listing des messages (hot path de la page mail).
// Bypass l'API record PB et ses access rules per-row (qui forcaient un JOIN
// users + validation par ligne sur 37k mails => 25s par requete).
//
// Cet endpoint :
//   - applique l'ownership en resolvant d'abord les dossiers de l'utilisateur
//   - ne lit que des index (idx_msg_list_keys + idx_msg_list_cover), jamais
//     une ligne de `messages` (corps inline) ; aucun tri sur la boite entiere
//   - retourne directement le JSON sans validation per-row
//   - ordre total (date DESC, id DESC) : pagination stable
//
// GET /api/mail/list
// Query params (tous optionnels sauf indique) :
//   account_id           : id du compte (ou "all" / omis pour tous)
//   folder_id            : id d'un dossier
//   folder_ids           : liste d'ids separes par virgules
//   folder_type          : type standard (inbox/sent/drafts/trash/spam/archive)
//   label_id             : id d'un label (filtre sur messages.labels, index-only)
//   exclude_secondary    : "true" pour exclure les messages portant au moins
//                          un label is_secondary=true (boite de reception)
//   view                 : "starred" | "all_mail" | "unread" (vues virtuelles)
//   is_read, is_starred, is_answered, is_draft, is_sent, has_attachments : "true"/"false"
//   priority             : "low"/"normal"/"high"
//   from_text            : recherche dans from_address (name/address) - LIKE
//   body_text            : recherche dans subject + text_body - LIKE
//   sort                 : "date" (default) | "unread_date" (is_read asc, date desc)
//   page                 : 1+ (default 1)
//   per_page             : 1-200 (default 100)
//   importance           : "important" | "secondary" | "low" (pastilles de niveau)
//   with_importance_counts : "true" -> ajoute `importance_counts`
//                          { important, secondary, low } = NON LUS par niveau
//                          dans le meme contexte (dossier, compte, label...),
//                          sans tenir compte du filtre de niveau ni de lu/non lu
//   with_tails           : "true" -> ajoute `thread_tails` { thread_id: message }
//                          = dernier message de chaque fil de la page, tous
//                          dossiers confondus (envoyes compris), is_answered
//                          uni sur les copies multi-comptes (idx_msg_thread_tail)

routerAdd("GET", "/api/mail/list", (e) => {
  var authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }
  var userId = authRecord.id;
  var q = e.request.url.query();

  var page = Math.max(parseInt(q.get("page") || "1", 10) || 1, 1);
  var perPage = parseInt(q.get("per_page") || "100", 10) || 100;
  if (perPage < 1) perPage = 1;
  if (perPage > 200) perPage = 200;

  // ---------------------------------------------------------------------
  // PRINCIPE (migration 067) : le temps de reponse ne doit plus dependre de la
  // taille de la boite.
  //
  // Avant, chaque appel (1) comptait en relisant la LIGNE de chaque message
  // (corps inline ~61 Ko, colonnes utiles rangees APRES html_body) et (2)
  // triait toute la boite (TEMP B-TREE sur ~35 000 entrees de l'index couvrant)
  // pour n'en garder que 50. Mesure sur 38 700 mails : 1,1 s a chaud / 7,5 s a
  // froid pour "Tous les messages", 21-34 s pour un label.
  //
  // Maintenant :
  //   - les dossiers cibles sont resolus D'ABORD (quelques dizaines de lignes),
  //     ce qui supprime les JOIN accounts/folders/message_labels ;
  //   - une sous-requete PAR DOSSIER suit l'ordre d'un index
  //     (folder, is_draft, date, id) et s'arrete a LIMIT : aucun tri global ;
  //   - seules les CLES (folder, is_draft, date, id) remontent ; les colonnes
  //     d'affichage ne sont lues que pour les lignes de la page, par un seek
  //     dans l'index couvrant idx_msg_list_cover ;
  //   - le COUNT lit l'index etroit idx_msg_list_keys (~4 Mo), jamais une ligne.
  //
  // Deux index, deux roles :
  //   idx_msg_list_keys  (etroit)   : cles + drapeaux + labels + expediteur
  //                                   -> filtres et COUNT
  //   idx_msg_list_cover (couvrant) : toutes les colonnes projetees -> affichage
  // Une colonne FILTREE ici doit etre dans idx_msg_list_keys (sinon la marquer
  // "c" ci-dessous) ; une colonne PROJETEE doit etre dans idx_msg_list_cover.
  // ---------------------------------------------------------------------
  var KEYS_IDX = "idx_msg_list_keys";
  var COVER_IDX = "idx_msg_list_cover";

  var bindings = {};

  var accountId = q.get("account_id") || "";
  if (accountId === "all") accountId = "";

  var view = q.get("view") || "";
  var folderType = q.get("folder_type") || "";
  var folderId = q.get("folder_id") || "";
  var folderIdsRaw = q.get("folder_ids") || "";
  var labelId = q.get("label_id") || "";

  // --- Dossiers de l'utilisateur (ownership = un dossier de SES comptes) ---
  var folderRows = arrayOf(new DynamicModel({ "id": "", "type": "", "account": "" }));
  try {
    $app.db()
      .newQuery(
        "SELECT f.id AS id, f.type AS type, f.account AS account FROM folders f " +
        "JOIN accounts a ON f.account = a.id WHERE a.user = {:userId}"
      )
      .bind({ "userId": userId })
      .all(folderRows);
  } catch (err) {
    var emsg0 = "" + err;
    console.log("mail-list: folders lookup error: " + emsg0);
    return e.json(500, { error: "folders_failed", detail: emsg0 });
  }

  var wantedIds = null;
  if (view !== "starred" && view !== "all_mail" && view !== "unread") {
    if (folderId) {
      wantedIds = {};
      wantedIds[folderId] = true;
    } else if (folderIdsRaw) {
      var rawIds = folderIdsRaw.split(",").filter(function (s) { return s.length > 0; });
      if (rawIds.length > 0) {
        wantedIds = {};
        for (var k = 0; k < rawIds.length; k++) wantedIds[rawIds[k]] = true;
      }
    }
  }
  // Le spam n'apparait QUE dans "all_mail", dans le dossier spam lui-meme, ou
  // quand un dossier est explicitement cible ; jamais dans les vues sans
  // contrainte de dossier (favoris, labels).
  var hasFolderConstraint = !!(folderId || folderIdsRaw || folderType);

  var targetFolders = [];
  for (var fi = 0; fi < folderRows.length; fi++) {
    var fr = folderRows[fi];
    if (accountId && fr.account !== accountId) continue;
    var keep;
    if (view === "all_mail") {
      // "Tous les messages" = tout sauf la corbeille.
      keep = fr.type !== "trash";
    } else if (view === "unread") {
      // Non lus, tous dossiers confondus, sauf spam / corbeille / brouillons.
      keep = fr.type !== "spam" && fr.type !== "trash" && fr.type !== "drafts";
    } else if (view === "starred") {
      keep = hasFolderConstraint ? true : fr.type !== "spam";
    } else if (wantedIds) {
      keep = !!wantedIds[fr.id];
    } else if (folderType) {
      keep = fr.type === folderType;
    } else {
      keep = fr.type !== "spam";
    }
    if (keep) targetFolders.push(fr.id);
  }

  // --- Conditions --------------------------------------------------------
  // Chaque condition porte sa provenance :
  //   "k" : colonnes de idx_msg_list_keys (index-only, etroit)
  //   "c" : colonnes de idx_msg_list_cover seulement (subject, to_addresses)
  //   "t" : colonne hors index (text_body) -> lecture de ligne, lent par nature
  // `sel` = condition selective (peu de lignes la passent) ; `listOnly` =
  // appliquee a la liste mais pas au COUNT (expediteurs bloques, historique).
  var conds = [];
  var addCond = function (src, sql, opts) {
    conds.push({
      src: src,
      sql: sql,
      sel: !!(opts && opts.sel),
      listOnly: !!(opts && opts.listOnly),
      // Ignoree par le comptage des pastilles de niveau (niveau, lu/non lu).
      noImpCount: !!(opts && opts.noImpCount),
    });
  };

  if (accountId) {
    addCond("k", "@.account = {:accountId}");
    bindings.accountId = accountId;
  }
  if (view === "starred") addCond("k", "@.is_starred = TRUE", { sel: true });
  if (view === "all_mail") addCond("k", "@.is_sent = FALSE");
  if (view === "unread") addCond("k", "@.is_read = FALSE", { sel: true });

  // is_draft fait partie de la cle des index : traite a part (une sous-requete
  // par valeur). Le frontend le passe explicitement ; absent = les deux.
  var draftParam = q.get("is_draft");
  var draftVals = draftParam === "true" ? ["TRUE"] : draftParam === "false" ? ["FALSE"] : ["FALSE", "TRUE"];

  var readParam = "";
  var boolFields = ["is_read", "is_starred", "is_answered", "is_sent", "has_attachments"];
  for (var i = 0; i < boolFields.length; i++) {
    var f = boolFields[i];
    var v = q.get(f);
    if (v !== "true" && v !== "false") continue;
    if (f === "is_read") readParam = v;
    // Majoritaires dans une boite : lus, non favoris, non envoyes, sans PJ.
    var common =
      (f === "is_read" && v === "true") ||
      (f === "is_starred" && v === "false") ||
      (f === "is_sent" && v === "false") ||
      (f === "has_attachments" && v === "false") ||
      (f === "is_answered" && v === "false");
    addCond("k", "@." + f + " = " + (v === "true" ? "TRUE" : "FALSE"), { sel: !common, noImpCount: f === "is_read" });
  }

  // Niveau d'importance (pastilles Importants / Secondaires / Peu utiles,
  // migration 075). Colonne de idx_msg_list_keys -> filtre index-only.
  var importance = q.get("importance") || "";
  if (importance === "important" || importance === "secondary" || importance === "low") {
    addCond("k", "@.importance = {:importance}", { sel: importance !== "low", noImpCount: true });
    bindings.importance = importance;
  }

  var priority = q.get("priority") || "";
  if (priority === "low" || priority === "normal" || priority === "high") {
    addCond("k", "@.priority = {:priority}", { sel: priority !== "normal" });
    bindings.priority = priority;
  }

  var fromText = (q.get("from_text") || "").trim();
  if (fromText.length > 0) {
    addCond("k", "(@.from_address LIKE {:fromLike})", { sel: true });
    bindings.fromLike = "%" + fromText + "%";
  }

  var bodyText = (q.get("body_text") || "").trim();
  if (bodyText.length > 0) {
    addCond("t", "(@.subject LIKE {:bodyLike} OR @.text_body LIKE {:bodyLike})");
    bindings.bodyLike = "%" + bodyText + "%";
  }

  // search_text : repli historique (sujet + expediteur + destinataires en LIKE).
  // La recherche de l'application passe par le worker (/search/mail) ; ce
  // parametre ne sert plus qu'aux appels directs de l'API.
  var searchText = (q.get("search_text") || "").trim();
  if (searchText.length > 0) {
    addCond(
      "c",
      "(@.subject LIKE {:searchLike} OR @.from_address LIKE {:searchLike} OR @.to_addresses LIKE {:searchLike})"
    );
    bindings.searchLike = "%" + searchText + "%";
  }

  // Label : messages.labels (JSON, source de verite par message) est dans
  // idx_msg_list_keys -> filtre index-only. L'ancien JOIN message_labels (table
  // miroir) forcait la lecture d'une LIGNE ENTIERE par message du label avant
  // tri : 21 a 34 s mesures pour ~900 messages.
  if (labelId) {
    addCond("k", "@.labels LIKE {:labelLike}", { sel: true });
    bindings.labelLike = '%"' + labelId + '"%';
  }

  // Boite de reception : exclure les messages portant au moins un label
  // is_secondary=true (quelques dizaines de labels au plus).
  if (q.get("exclude_secondary") === "true") {
    var secRows = arrayOf(new DynamicModel({ "id": "" }));
    try {
      $app.db()
        .newQuery("SELECT id FROM labels WHERE user = {:userId} AND is_secondary = TRUE")
        .bind({ "userId": userId })
        .all(secRows);
    } catch (err) {
      console.log("mail-list: secondary labels lookup error: " + err);
    }
    for (var s = 0; s < secRows.length; s++) {
      var sKey = "secLike_" + s;
      addCond("k", "(@.labels IS NULL OR @.labels NOT LIKE {:" + sKey + "})");
      bindings[sKey] = '%"' + secRows[s].id + '"%';
    }
  }

  // Expediteurs bloques : jamais affiches, dans aucune vue. NOT LIKE par adresse
  // sur from_address (JSON name+address), sur la LISTE seulement.
  var blkRows = arrayOf(new DynamicModel({ "blocked_senders": "" }));
  try {
    $app.db()
      .newQuery("SELECT blocked_senders FROM users WHERE id = {:userId}")
      .bind({ "userId": userId })
      .all(blkRows);
  } catch (err) {
    console.log("mail-list: blocked_senders lookup error: " + err);
  }
  if (blkRows.length) {
    var blocked = [];
    try { blocked = JSON.parse(blkRows[0].blocked_senders || "[]") || []; } catch (_) { blocked = []; }
    for (var bI = 0; bI < blocked.length; bI++) {
      var bEmail = ("" + blocked[bI]).toLowerCase().trim();
      if (!bEmail) continue;
      var bKey = "blk_" + bI;
      // LIKE est deja insensible a la casse (ASCII) en SQLite.
      addCond("k", "(@.from_address IS NULL OR @.from_address NOT LIKE {:" + bKey + "})", { listOnly: true });
      bindings[bKey] = "%" + bEmail + "%";
    }
  }

  var sort = q.get("sort") || "date";
  var unreadFirst = sort === "unread_date";
  var offset = (page - 1) * perPage;

  var emptyResponse = function () {
    return e.json(200, {
      importance_counts: q.get("with_importance_counts") === "true" ? { important: 0, secondary: 0, low: 0 } : null,
      thread_tails: q.get("with_tails") === "true" ? {} : null,
      items: [],
      page: page,
      perPage: perPage,
      totalItems: 0,
      totalPages: 0,
    });
  };
  if (targetFolders.length === 0) return emptyResponse();

  var folderPh = [];
  for (var tf = 0; tf < targetFolders.length; tf++) {
    bindings["tf_" + tf] = targetFolders[tf];
    folderPh.push("{:tf_" + tf + "}");
  }

  // Rend les conditions (liste ou COUNT) pour une source donnee : `only` filtre
  // les provenances, `alias` remplace le "@".
  var renderConds = function (forList, only, alias) {
    var out = [];
    for (var ci = 0; ci < conds.length; ci++) {
      var c = conds[ci];
      if (c.listOnly && !forList) continue;
      if (only && only.indexOf(c.src) === -1) continue;
      out.push(c.sql.split("@").join(alias));
    }
    return out;
  };
  var hasSrc = function (forList, src) {
    for (var ci = 0; ci < conds.length; ci++) {
      if (conds[ci].listOnly && !forList) continue;
      if (conds[ci].src === src) return true;
    }
    return false;
  };
  var hasSelective = function () {
    for (var ci = 0; ci < conds.length; ci++) if (conds[ci].sel) return true;
    return false;
  };

  var LIST_COLS =
    "  m.id AS id, " +
    "  m.account AS account, " +
    "  COALESCE(m.folder, '') AS folder, " +
    "  COALESCE(m.thread_id, '') AS thread_id, " +
    "  COALESCE(m.message_id, '') AS message_id, " +
    "  COALESCE(m.in_reply_to, '') AS in_reply_to, " +
    "  COALESCE(m.[references], '') AS refs, " +
    "  COALESCE(m.from_address, '') AS from_address, " +
    "  COALESCE(m.to_addresses, '') AS to_addresses, " +
    "  COALESCE(m.cc_addresses, '') AS cc_addresses, " +
    "  COALESCE(m.subject, '') AS subject, " +
    "  COALESCE(m.snippet, '') AS snippet, " +
    "  COALESCE(m.date, '') AS date, " +
    "  CAST(COALESCE(m.is_read, 0) AS INTEGER) AS is_read, " +
    "  CAST(COALESCE(m.is_starred, 0) AS INTEGER) AS is_starred, " +
    "  CAST(COALESCE(m.is_answered, 0) AS INTEGER) AS is_answered, " +
    "  CAST(COALESCE(m.is_draft, 0) AS INTEGER) AS is_draft, " +
    "  CAST(COALESCE(m.is_sent, 0) AS INTEGER) AS is_sent, " +
    "  CAST(COALESCE(m.has_attachments, 0) AS INTEGER) AS has_attachments, " +
    "  COALESCE(m.priority, 'normal') AS priority, " +
    "  CAST(COALESCE(m.uid, 0) AS INTEGER) AS uid, " +
    "  COALESCE(m.labels, '') AS labels, " +
    "  CAST(COALESCE(m.spam_score, 0) AS TEXT) AS spam_score, " +
    "  COALESCE(m.spam_action, '') AS spam_action, " +
    "  COALESCE(m.scheduled_at, '') AS scheduled_at, " +
    "  COALESCE(m.importance, '') AS importance ";

  // --- COUNT : index-only ------------------------------------------------
  // Index etroit quand tous les filtres y sont ; index couvrant si un filtre
  // porte sur une colonne d'affichage (search_text) ; `keysIdx`
  // absent (migration 067 pas encore appliquee) -> index couvrant.
  var buildCountSql = function (keysIdx) {
    var src = hasSrc(false, "c") || !keysIdx ? COVER_IDX : keysIdx;
    // body_text lit text_body : aucun index ne le porte, pas de hint force.
    var hint = hasSrc(false, "t") ? "" : " INDEXED BY " + src + " ";
    var w = ["k.folder IN (" + folderPh.join(",") + ")", "k.is_draft IN (" + draftVals.join(",") + ")"]
      .concat(renderConds(false, null, "k"));
    return "SELECT COUNT(*) AS cnt FROM messages k" + hint + " WHERE " + w.join(" AND ");
  };

  // --- LISTE : cles par dossier, dans l'ordre de l'index -----------------
  var buildListSql = function (keysIdx) {
    var needCover = hasSrc(true, "c");
    var needTable = hasSrc(true, "t");
    var selective = hasSelective();
    // Tri "non lus d'abord" : une sous-requete par valeur de is_read, chacune
    // dans l'ordre de l'index.
    var readVals = unreadFirst && !readParam && view !== "unread" ? ["FALSE", "TRUE"] : [null];
    // L'ordre (date DESC, id DESC) est total : chaque dossier ne peut fournir
    // que ses (offset + perPage) premieres cles a la page demandee.
    var subLimit = offset + perPage;

    var subs = [];
    for (var a = 0; a < targetFolders.length; a++) {
      for (var d = 0; d < draftVals.length; d++) {
        for (var r = 0; r < readVals.length; r++) {
          var from;
          var w = ["k.folder = {:tf_" + a + "}", "k.is_draft = " + draftVals[d]];
          if (readVals[r] !== null) w.push("k.is_read = " + readVals[r]);
          if (needTable) {
            // text_body : lecture de ligne inevitable, sans hint.
            from = "messages k";
            w = w.concat(renderConds(true, null, "k"));
          } else if (!needCover && keysIdx) {
            from = "messages k INDEXED BY " + keysIdx;
            w = w.concat(renderConds(true, null, "k"));
          } else if (!keysIdx || (!selective && readVals[r] !== "FALSE")) {
            // Filtre sur une colonne d'affichage, rien de selectif a cote :
            // parcours direct de l'index couvrant dans l'ordre, arret a LIMIT.
            from = "messages k INDEXED BY " + COVER_IDX;
            w = w.concat(renderConds(true, null, "k"));
          } else {
            // Filtre selectif + filtre d'affichage : l'index etroit trouve les
            // candidats, l'index couvrant n'est consulte QUE pour eux.
            from =
              "messages k INDEXED BY " + keysIdx +
              " CROSS JOIN messages c INDEXED BY " + COVER_IDX +
              " ON c.folder = k.folder AND c.is_draft = k.is_draft AND c.date = k.date AND c.id = k.id";
            w = w.concat(renderConds(true, ["k"], "k")).concat(renderConds(true, ["c"], "c"));
          }
          subs.push(
            "SELECT kf, kd, kdate, kid, kr FROM (" +
            "SELECT k.folder AS kf, k.is_draft AS kd, k.date AS kdate, k.id AS kid, k.is_read AS kr " +
            "FROM " + from + " WHERE " + w.join(" AND ") +
            " ORDER BY k.date DESC, k.id DESC LIMIT " + subLimit + ")"
          );
        }
      }
    }
    // SQLite plafonne un SELECT compose a 500 termes.
    if (subs.length > 400) return null;

    var keyOrder = unreadFirst ? "kr ASC, kdate DESC, kid DESC" : "kdate DESC, kid DESC";
    return (
      "SELECT " + LIST_COLS +
      "FROM (" + subs.join(" UNION ALL ") +
      " ORDER BY " + keyOrder + " LIMIT " + perPage + " OFFSET " + offset + ") x " +
      "CROSS JOIN messages m INDEXED BY " + COVER_IDX +
      " ON m.folder = x.kf AND m.is_draft = x.kd AND m.date = x.kdate AND m.id = x.kid " +
      "ORDER BY " + (unreadFirst ? "x.kr ASC, " : "") + "x.kdate DESC, x.kid DESC"
    );
  };

  // Repli : une seule requete a plat sur l'index couvrant (tri global). Sert si
  // idx_msg_list_keys n'existe pas encore ou si le chemin rapide echoue ; lent
  // sur une grosse boite mais toujours juste.
  var buildFlatListSql = function () {
    var hint = hasSrc(true, "t") ? "" : " INDEXED BY " + COVER_IDX + " ";
    var w = ["m.folder IN (" + folderPh.join(",") + ")", "m.is_draft IN (" + draftVals.join(",") + ")"]
      .concat(renderConds(true, null, "m"));
    return (
      "SELECT " + LIST_COLS + "FROM messages m" + hint +
      " WHERE " + w.join(" AND ") +
      " ORDER BY " + (unreadFirst ? "m.is_read ASC, " : "") + "m.date DESC, m.id DESC" +
      " LIMIT " + perPage + " OFFSET " + offset
    );
  };

  var totalItems = 0;
  var runCount = function (sql) {
    var countRows = arrayOf(new DynamicModel({ "cnt": 0 }));
    $app.db().newQuery(sql).bind(bindings).all(countRows);
    return countRows.length ? countRows[0].cnt : 0;
  };
  var keysIdxOk = true;
  try {
    totalItems = runCount(buildCountSql(KEYS_IDX));
  } catch (err) {
    keysIdxOk = false;
    console.log("mail-list: count rapide indisponible (" + err + ") -> index couvrant");
    try {
      totalItems = runCount(buildCountSql(null));
    } catch (err2) {
      var emsg = "" + err2;
      console.log("mail-list: count error: " + emsg);
      return e.json(500, { error: "count_failed", detail: emsg });
    }
  }

  var newRows = function () {
    return arrayOf(new DynamicModel({
      "id": "", "account": "", "folder": "", "thread_id": "",
      "message_id": "", "in_reply_to": "", "refs": "",
      "from_address": "", "to_addresses": "", "cc_addresses": "",
      "subject": "", "snippet": "", "date": "",
      "is_read": 0, "is_starred": 0, "is_answered": 0,
      "is_draft": 0, "is_sent": 0, "has_attachments": 0,
      "priority": "", "uid": 0, "labels": "",
      "spam_score": "", "spam_action": "", "scheduled_at": "", "importance": "",
    }));
  };
  var rows = newRows();
  var listDone = false;
  if (totalItems === 0 && !hasSrc(true, "t")) {
    listDone = true;
  } else {
    var fastSql = buildListSql(keysIdxOk ? KEYS_IDX : null);
    if (fastSql) {
      try {
        $app.db().newQuery(fastSql).bind(bindings).all(rows);
        listDone = true;
      } catch (err) {
        console.log("mail-list: liste rapide en echec (" + err + ") -> requete a plat");
        rows = newRows();
      }
    }
  }
  if (!listDone) {
    try {
      $app.db().newQuery(buildFlatListSql()).bind(bindings).all(rows);
    } catch (err) {
      var emsg2 = "" + err;
      console.log("mail-list: list error: " + emsg2);
      return e.json(500, { error: "list_failed", detail: emsg2 });
    }
  }
  var safeParse = function (s, dflt) {
    if (s === null || s === undefined || s === "") return dflt;
    try { return JSON.parse(s); } catch (_) { return dflt; }
  };

  var items = [];
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    items.push({
      id: r.id,
      account: r.account,
      folder: r.folder,
      thread_id: r.thread_id,
      message_id: r.message_id,
      in_reply_to: r.in_reply_to,
      references: safeParse(r.refs, []),
      from_address: safeParse(r.from_address, { address: "", name: "" }),
      to_addresses: safeParse(r.to_addresses, []),
      cc_addresses: safeParse(r.cc_addresses, []),
      subject: r.subject,
      snippet: r.snippet,
      date: r.date,
      is_read: !!r.is_read,
      is_starred: !!r.is_starred,
      is_answered: !!r.is_answered,
      is_draft: !!r.is_draft,
      is_sent: !!r.is_sent,
      has_attachments: !!r.has_attachments,
      priority: r.priority || "normal",
      uid: r.uid || 0,
      labels: safeParse(r.labels, []),
      spam_score: r.spam_score ? parseFloat(r.spam_score) || 0 : 0,
      spam_action: r.spam_action || "",
      scheduled_at: r.scheduled_at || "",
      importance: r.importance || "",
    });
  }

  // --- Dernier message de chaque fil (with_tails=true) -------------------
  // La liste d'un dossier ne contient que les messages DE ce dossier : un fil
  // repondu ne montrait jamais la reponse (elle vit dans "Envoyes"). On renvoie
  // en plus, pour chaque thread_id de la page, son dernier message tous
  // dossiers confondus (hors brouillons / corbeille / spam), avec is_answered
  // UNI sur les copies du meme Message-ID (un mail recu sur deux comptes lies
  // existe en double et seules certaines copies portent le flag \Answered).
  // Servi par l'index couvrant idx_msg_thread_tail (migration 064) : le SELECT
  // ne doit lire QUE des colonnes de cet index.
  var threadTails = null;
  if (q.get("with_tails") === "true" && items.length > 0) {
    threadTails = {};
    var tailBindings = { "userId": userId };
    var tailPh = [];
    var seenTid = {};
    for (var ti = 0; ti < items.length && tailPh.length < 200; ti++) {
      var tid = items[ti].thread_id;
      if (!tid || seenTid[tid]) continue;
      seenTid[tid] = true;
      var tKey = "tt_" + tailPh.length;
      tailPh.push("{:" + tKey + "}");
      tailBindings[tKey] = tid;
    }
    if (tailPh.length > 0) {
      var tailSql =
        "SELECT * FROM (" +
        "SELECT m.id AS id, m.account AS account, COALESCE(m.folder, '') AS folder, " +
        "  m.thread_id AS thread_id, COALESCE(m.message_id, '') AS message_id, " +
        "  COALESCE(m.from_address, '') AS from_address, " +
        "  COALESCE(m.to_addresses, '') AS to_addresses, " +
        "  COALESCE(m.cc_addresses, '') AS cc_addresses, " +
        "  COALESCE(m.subject, '') AS subject, COALESCE(m.snippet, '') AS snippet, " +
        "  COALESCE(m.date, '') AS date, " +
        "  CAST(COALESCE(m.is_read, 0) AS INTEGER) AS is_read, " +
        "  CAST(COALESCE(m.is_answered, 0) AS INTEGER) AS is_answered, " +
        "  CAST(COALESCE(m.is_sent, 0) AS INTEGER) AS is_sent, " +
        "  CAST(COALESCE(m.has_attachments, 0) AS INTEGER) AS has_attachments, " +
        "  COALESCE(m.labels, '') AS labels, " +
        "  ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC) AS rn " +
        "FROM messages m INDEXED BY idx_msg_thread_tail " +
        "JOIN accounts a ON m.account = a.id " +
        "JOIN folders f ON m.folder = f.id " +
        "WHERE a.user = {:userId} AND m.is_draft = FALSE " +
        "  AND f.type NOT IN ('trash', 'spam') " +
        "  AND m.thread_id IN (" + tailPh.join(",") + ")" +
        ") WHERE rn <= 4 ORDER BY thread_id, rn";
      var tailRows = arrayOf(new DynamicModel({
        "id": "", "account": "", "folder": "", "thread_id": "", "message_id": "",
        "from_address": "", "to_addresses": "", "cc_addresses": "",
        "subject": "", "snippet": "", "date": "",
        "is_read": 0, "is_answered": 0, "is_sent": 0, "has_attachments": 0,
        "labels": "", "rn": 0,
      }));
      try {
        $app.db().newQuery(tailSql).bind(tailBindings).all(tailRows);
      } catch (err) {
        // Best effort : la liste reste servie sans les tails.
        console.log("mail-list: tails error: " + err);
        tailRows = [];
      }
      var normMid = function (s) {
        return ("" + (s || "")).replace(/^<|>$/g, "").toLowerCase().trim();
      };
      for (var tr = 0; tr < tailRows.length; tr++) {
        var row = tailRows[tr];
        var existing = threadTails[row.thread_id];
        if (!existing) {
          threadTails[row.thread_id] = {
            id: row.id,
            account: row.account,
            folder: row.folder,
            thread_id: row.thread_id,
            message_id: row.message_id,
            in_reply_to: "",
            references: [],
            from_address: safeParse(row.from_address, { address: "", name: "" }),
            to_addresses: safeParse(row.to_addresses, []),
            cc_addresses: safeParse(row.cc_addresses, []),
            subject: row.subject,
            snippet: row.snippet,
            date: row.date,
            is_read: !!row.is_read,
            is_starred: false,
            is_answered: !!row.is_answered,
            is_draft: false,
            is_sent: !!row.is_sent,
            has_attachments: !!row.has_attachments,
            priority: "normal",
            uid: 0,
            labels: safeParse(row.labels, []),
            spam_score: 0,
            spam_action: "",
            scheduled_at: "",
          };
        } else if (
          row.is_answered &&
          existing.message_id &&
          normMid(row.message_id) === normMid(existing.message_id)
        ) {
          existing.is_answered = true;
        }
      }
    }
  }

  // --- Pastilles de niveau : non lus par niveau, index-only ---------------
  var importanceCounts = null;
  if (q.get("with_importance_counts") === "true") {
    importanceCounts = { important: 0, secondary: 0, low: 0 };
    try {
      var impConds = [];
      var impNeedsRow = false;
      var impNeedsCover = false;
      for (var ic = 0; ic < conds.length; ic++) {
        var cc = conds[ic];
        if (cc.listOnly || cc.noImpCount) continue;
        if (cc.src === "t") impNeedsRow = true;
        if (cc.src === "c") impNeedsCover = true;
        impConds.push(cc.sql.split("@").join("k"));
      }
      var impIdx = impNeedsCover || !keysIdxOk ? COVER_IDX : KEYS_IDX;
      var impHint = impNeedsRow ? "" : " INDEXED BY " + impIdx + " ";
      var impW = [
        "k.folder IN (" + folderPh.join(",") + ")",
        "k.is_draft IN (" + draftVals.join(",") + ")",
        "k.is_read = FALSE",
        "k.importance IN ('important','secondary','low')",
      ].concat(impConds);
      var impRows = arrayOf(new DynamicModel({ "imp": "", "cnt": 0 }));
      $app.db()
        .newQuery(
          "SELECT k.importance AS imp, COUNT(*) AS cnt FROM messages k" + impHint +
          " WHERE " + impW.join(" AND ") + " GROUP BY k.importance"
        )
        .bind(bindings)
        .all(impRows);
      for (var ir = 0; ir < impRows.length; ir++) {
        if (importanceCounts.hasOwnProperty(impRows[ir].imp)) {
          importanceCounts[impRows[ir].imp] = impRows[ir].cnt;
        }
      }
    } catch (err) {
      console.log("mail-list: importance counts error: " + err);
    }
  }

  return e.json(200, {
    importance_counts: importanceCounts,
    thread_tails: threadTails,
    items: items,
    page: page,
    perPage: perPage,
    totalItems: totalItems,
    totalPages: Math.ceil(totalItems / perPage),
  });
}, $apis.requireAuth());
