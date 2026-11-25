/// <reference path="../pb_data/types.d.ts" />

// mail-ai.pb.js
// Headless API for the AI mail-analysis agent (thread "briefs" = private
// AI-generated notes, collection `thread_briefs`).
//
//   GET    /api/mail/thread/{threadId}/brief    read the AI note
//   POST   /api/mail/thread/{threadId}/brief    (re)generate the AI note
//   DELETE /api/mail/thread/{threadId}/brief    delete the AI note
//   GET    /api/mail/briefs                     list all the user's AI notes
//   GET    /api/mail/thread/{threadId}/context  thread messages + brief in one call
//
// Generation calls OpenRouter directly (Bearer OPENROUTER_API_KEY) using the
// DeepSeek model. Incremental by default: when a note already exists, only
// the new messages are sent with the previous note for update; pass
// force=true to recompute from the whole thread.

var OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
var OPENROUTER_API_KEY = $os.getenv("OPENROUTER_API_KEY") || "";
var OPENROUTER_MODEL = $os.getenv("OPENROUTER_MODEL") || "deepseek/deepseek-chat-v3-0324";
var OPENROUTER_MODEL_NEWSLETTER = $os.getenv("OPENROUTER_MODEL_NEWSLETTER") || "google/gemini-2.5-flash-lite";
var OPENROUTER_MODEL_CONVERSATION = $os.getenv("OPENROUTER_MODEL_CONVERSATION") || "";
var OPENROUTER_MODEL_SINGLE = $os.getenv("OPENROUTER_MODEL_SINGLE") || "";
var APP_URL = $os.getenv("NEXT_PUBLIC_APP_URL") || "https://pb.example.com";

var modelForKind = function(kind) {
  if (kind === "newsletter") return OPENROUTER_MODEL_NEWSLETTER || OPENROUTER_MODEL;
  if (kind === "conversation") return OPENROUTER_MODEL_CONVERSATION || OPENROUTER_MODEL;
  if (kind === "single") return OPENROUTER_MODEL_SINGLE || OPENROUTER_MODEL;
  return OPENROUTER_MODEL;
};

var LANG_NAMES = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
};

// ---------------------------------------------------------------------------
// HTML -> plain text : retire style/script/head, convertit les sauts de ligne
// structurels, decode les entites courantes, vire les URLs de tracking, et
// collapse les blancs. Cape la longueur si demande.
// ---------------------------------------------------------------------------
var HTML_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
  hellip: "...", mdash: "-", ndash: "-", laquo: "<<", raquo: ">>",
  copy: "(c)", reg: "(R)", trade: "(TM)", euro: "EUR", pound: "GBP",
  middot: "*", bull: "*", deg: "deg", zwnj: "", zwj: "", shy: "",
};

var decodeEntities = function(s) {
  return s
    .replace(/&#(\d+);/g, function(_, n) {
      var code = parseInt(n, 10);
      return (code > 0 && code < 0x10ffff) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, function(_, h) {
      var code = parseInt(h, 16);
      return (code > 0 && code < 0x10ffff) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]+);/g, function(m, name) {
      var v = HTML_ENTITIES[name.toLowerCase()];
      return (v === undefined) ? m : v;
    });
};

var plain = function(s, cap) {
  var t = s || "";
  if (/<[a-zA-Z!\/]/.test(t)) {
    t = t.replace(/<!--[\s\S]*?-->/g, " ");
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    t = t.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
    t = t.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
    t = t.replace(/<\s*br\s*\/?>/gi, "\n");
    t = t.replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|table|article|section|header|footer)\s*>/gi, "\n");
    t = t.replace(/<[^>]+>/g, " ");
    t = decodeEntities(t);
  }
  t = t.replace(/https?:\/\/\S{120,}/gi, "[lien]");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n[ \t]+/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/^\s+|\s+$/g, "");
  if (cap && t.length > cap) {
    t = t.substring(0, cap);
  }
  return t;
};

// ---------------------------------------------------------------------------
// Helper: light cleanup of the model output (no em/en dashes, no code fences)
// ---------------------------------------------------------------------------
var cleanAiHtml = function(text) {
  var out = (text || "").replace(/[\u2014\u2013]/g, "-");
  out = out.replace(/```html/gi, "").replace(/```/g, "");
  return out.replace(/^\s+|\s+$/g, "");
};

// ---------------------------------------------------------------------------
// Helper: load thread messages owned by the user, sorted oldest-first
// ---------------------------------------------------------------------------
var loadThreadMessages = function(app, threadId, userId) {
  return app.findRecordsByFilter(
    "messages",
    "thread_id = {:tid} && account.user = {:uid}",
    "date",
    500,
    0,
    { tid: threadId, uid: userId }
  );
};

// ---------------------------------------------------------------------------
// Helper: find the existing brief record for (user, thread)
// ---------------------------------------------------------------------------
var findBrief = function(app, userId, threadId) {
  try {
    var recs = app.findRecordsByFilter(
      "thread_briefs",
      "user = {:uid} && thread_id = {:tid}",
      "",
      1,
      0,
      { uid: userId, tid: threadId }
    );
    if (recs.length > 0) {
      return recs[0];
    }
  } catch (_) {}
  return null;
};

var serializeBrief = function(rec) {
  return {
    id: rec.id,
    thread_id: rec.get("thread_id"),
    content: rec.get("content"),
    message_count: rec.get("message_count"),
    last_message_id: rec.get("last_message_id"),
    last_message_date: rec.get("last_message_date"),
    created: rec.get("created"),
    updated: rec.get("updated"),
  };
};

// ---------------------------------------------------------------------------
// Helper: call the LLM gateway, return cleaned HTML
// ---------------------------------------------------------------------------
var generateBriefHtml = function(systemPrompt, userPrompt, kind) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured on the server");
  }
  var maxTokens = kind === "newsletter" ? 2500 : 1200;
  var res = $http.send({
    url: OPENROUTER_URL,
    method: "POST",
    body: JSON.stringify({
      model: modelForKind(kind),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + OPENROUTER_API_KEY,
      "HTTP-Referer": APP_URL,
      "X-Title": "iMiel",
    },
    timeout: 60,
  });

  if (res.statusCode >= 400) {
    throw new Error("OpenRouter HTTP " + res.statusCode + ": " + res.raw);
  }

  var data = res.json;
  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    throw new Error("Empty LLM response");
  }
  return cleanAiHtml(content);
};

// ---------------------------------------------------------------------------
// Helper: detect the brief "kind" -- conversation / single / newsletter
// ---------------------------------------------------------------------------
var NEWSLETTER_ADDR_RE = /(^|[<\s])(noreply|no-reply|donotreply|do-not-reply|newsletter|newsletters|notification|notifications|marketing|mailing|news|info|hello|updates?|team|community|digest|bulletin|press)@/i;
var NEWSLETTER_BODY_RE = /unsubscribe|se desabonner|se désabonner|désinscrire|abmelden|annulla iscrizione|view in browser|view in your browser|voir dans le navigateur|view as webpage|cet ?e?-?mail vous a été envoyé|you are receiving this email|vous recevez cet email/i;

var isNewsletterLike = function(m) {
  if (!m || m.mine) return false;
  var addr = (m.fromAddress || m.from || "").toLowerCase();
  if (NEWSLETTER_ADDR_RE.test(addr)) return true;
  if (NEWSLETTER_BODY_RE.test(m.body || "")) return true;
  return false;
};

var detectKind = function(msgs) {
  if (!msgs || msgs.length === 0) return "single";
  if (msgs.length === 1) {
    return isNewsletterLike(msgs[0]) ? "newsletter" : "single";
  }
  var hasMine = false;
  var senders = {};
  var nbSenders = 0;
  for (var i = 0; i < msgs.length; i++) {
    if (msgs[i].mine) { hasMine = true; continue; }
    var key = ((msgs[i].fromAddress || msgs[i].from || "") + "").toLowerCase();
    if (key && !senders[key]) { senders[key] = true; nbSenders++; }
  }
  if (hasMine || nbSenders > 1) return "conversation";
  return isNewsletterLike(msgs[0]) ? "newsletter" : "conversation";
};

var commonRules = function(lang) {
  return "- Ecris en " + lang + ".\n" +
    "- N'invente rien. N'ajoute aucune information absente des messages.\n" +
    "- N'utilise JAMAIS de tirets longs. Tirets courts (-) uniquement.\n" +
    "- Formate en HTML avec UNIQUEMENT ces balises : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. Pas de Markdown.\n" +
    "- Retourne UNIQUEMENT le HTML, sans aucun texte avant ou apres.";
};

var systemForKind = function(kind, lang, hasPrev) {
  if (kind === "conversation") {
    return "Tu es l'assistant IA d'iMiel. Tu rediges des NOTES PERSONNELLES de SUIVI pour l'utilisateur sur une DISCUSSION email (plusieurs messages echanges).\n\n" +
      commonRules(lang) + "\n" +
      "- Adopte le point de vue de l'utilisateur (les messages marques \"MOI\" sont les siens).\n" +
      "- Sois factuel, concis, telegraphique. Pas de blabla.\n" +
      "- Structure obligatoire :\n" +
      "  1. <p><strong>Resume global :</strong> un paragraphe court (2-4 phrases) qui synthetise le sujet, l'etat actuel et la prochaine action attendue.</p>\n" +
      "  2. <p><strong>Chronologie :</strong></p> suivi d'une <ul> ordonnee du plus ancien au plus recent. Chaque <li> commence par la date au format court (JJ/MM HH:MM), puis l'expediteur (MOI ou nom), puis en 1-2 phrases la substance du message (decisions, demandes, infos).\n" +
      "  3. <p><strong>En attente :</strong></p> liste a puces de ce qui doit etre fait et par qui. Omets cette section si rien n'est en attente.\n" +
      (hasPrev
        ? "- On te fournit des notes EXISTANTES et UNIQUEMENT les nouveaux messages. METS A JOUR : conserve le resume global (ajuste si necessaire), ajoute les nouvelles entrees a la chronologie, mets a jour la section En attente."
        : "- Analyse l'integralite de la discussion ci-dessous.");
  }

  if (kind === "newsletter") {
    return "Tu es l'assistant IA d'iMiel. Tu rediges un RESUME DETAILLE en " + lang + " d'une newsletter ou email automatise, de maniere a ce que l'utilisateur n'ait PAS BESOIN d'ouvrir l'email pour capter l'essentiel.\n\n" +
      commonRules(lang) + "\n" +
      "- Sois exhaustif sur le CONTENU EDITORIAL (articles, sujets, produits, annonces). Tu peux ecrire jusqu'a environ 500 mots si la newsletter est riche.\n" +
      "- Ignore les elements parasites : pied de page, liens de desabonnement, mentions legales, boutons sociaux.\n" +
      "- Structure obligatoire :\n" +
      "  1. <p><strong>Resume :</strong> un paragraphe synthetique qui presente l'angle / le message principal de cette edition.</p>\n" +
      "  2. <p><strong>A retenir :</strong></p> une <ul> courte de 2 a 5 puces avec les infos vraiment utiles a memoriser (chiffres, dates, decisions). Omets si rien de marquant.\n" +
      "  3. <p><strong>Au sommaire :</strong></p> suivi d'une <ul>. Une <li> par sujet/article/section : commence par le titre en <strong>, puis 1 a 3 phrases qui resument son contenu reel.\n" +
      "  4. <p><strong>Source :</strong> nom de l'emetteur et theme general en une ligne.</p>";
  }

  // single
  return "Tu es l'assistant IA d'iMiel. Tu rediges une NOTE DE LECTURE en " + lang + " pour un email unique recu par l'utilisateur.\n\n" +
    commonRules(lang) + "\n" +
    "- Reste concis : un memo qui permet de comprendre l'email sans l'ouvrir.\n" +
    "- Structure obligatoire :\n" +
    "  1. <p><strong>Expediteur :</strong> nom et, en quelques mots, le sujet reel du mail.</p>\n" +
    "  2. <p><strong>Resume :</strong> un paragraphe (2-5 phrases) qui restitue fidelement le contenu et l'intention du message.</p>\n" +
    "  3. <p><strong>Action attendue :</strong> ce que l'utilisateur doit faire (repondre, decider, valider, payer, etc.), avec deadline si mentionnee. Ecris \"Aucune action requise\" si c'est une simple information.</p>\n" +
    "  4. <p><strong>Points cles :</strong></p> une <ul> courte (2-5 puces) avec les infos importantes (chiffres, dates, noms, liens vers documents). Omets si le mail est trivial.";
};

// ---------------------------------------------------------------------------
// Helper: build the system + user prompts (ported from /api/ai/brief)
// ---------------------------------------------------------------------------
var buildPrompts = function(subject, lang, msgs, previousBrief, kind) {
  var hasPrev = typeof previousBrief === "string" && previousBrief.replace(/^\s+|\s+$/g, "") !== "";
  var useIncremental = hasPrev && kind === "conversation";

  var systemPrompt = systemForKind(kind, lang, useIncremental);

  var bodyCap = kind === "newsletter" ? 18000 : 5000;
  var parts = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    var who = m.mine ? "MOI" : (m.from || "inconnu");
    parts.push("[" + m.date + "] " + who + " :\n" + plain(m.body, bodyCap));
  }
  var transcript = parts.join("\n\n---\n\n");

  var prevSection;
  if (useIncremental) {
    prevSection =
      "Notes existantes a mettre a jour :\n" + plain(previousBrief, 4000) +
      "\n\n---\n\n" + (msgs.length > 1 ? "Nouveaux messages" : "Nouveau message") + " :\n";
  } else if (kind === "newsletter") {
    prevSection = "Contenu de la newsletter :\n";
  } else if (kind === "single") {
    prevSection = "Email :\n";
  } else {
    prevSection = "Discussion (du plus ancien au plus recent) :\n";
  }

  var userPrompt = "Sujet : " + (subject || "(sans sujet)") + "\n\n" + prevSection + transcript;

  return { system: systemPrompt, user: userPrompt, kind: kind };
};

// ===========================================================================
// API: get the AI note for a thread
// ===========================================================================
routerAdd("GET", "/api/mail/thread/{threadId}/brief", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const threadId = e.request.pathValue("threadId");
  if (!threadId) {
    throw new BadRequestError("threadId is required");
  }

  const rec = findBrief($app, authRecord.id, threadId);
  if (!rec) {
    return e.json(404, { error: "No AI note for this thread" });
  }

  return e.json(200, { brief: serializeBrief(rec) });
}, $apis.requireAuth());

// ===========================================================================
// API: (re)generate the AI note for a thread
// body: { language?: "fr"|"en"|"de"|"it", force?: boolean }
// ===========================================================================
routerAdd("POST", "/api/mail/thread/{threadId}/brief", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const threadId = e.request.pathValue("threadId");
  if (!threadId) {
    throw new BadRequestError("threadId is required");
  }

  const body = e.requestInfo().body || {};
  const language = body.language || "fr";
  const lang = LANG_NAMES[language] || LANG_NAMES.fr;
  const force = body.force === true;

  const records = loadThreadMessages($app, threadId, authRecord.id);
  if (records.length === 0) {
    return e.json(404, { error: "Thread not found or empty" });
  }

  const existing = findBrief($app, authRecord.id, threadId);
  const incremental = !force && existing && (existing.get("content") || "") !== "";

  // Build the message list for the model
  const allMsgs = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const fromAddr = r.get("from_address") || {};
    allMsgs.push({
      id: r.id,
      date: r.get("date"),
      mine: !!r.get("is_sent"),
      from: fromAddr.name || fromAddr.address || "inconnu",
      fromAddress: fromAddr.address || "",
      body: r.get("text_body") || r.get("html_body") || r.get("snippet") || "",
    });
  }

  // Detection de type basee sur l'integralite du thread (pas seulement les nouveaux)
  const kind = detectKind(allMsgs);
  // L'incremental n'a de sens que pour les discussions multi-messages
  const useIncremental = incremental && kind === "conversation";

  let payloadMsgs = allMsgs;
  if (useIncremental) {
    const lastDate = existing.get("last_message_date");
    const lastId = existing.get("last_message_id");
    const filtered = [];
    for (let j = 0; j < allMsgs.length; j++) {
      const mm = allMsgs[j];
      if (lastDate ? mm.date > lastDate : mm.id !== lastId) {
        filtered.push(mm);
      }
    }
    if (filtered.length === 0) {
      // Nothing new — return the existing note unchanged
      return e.json(200, { status: "unchanged", brief: serializeBrief(existing) });
    }
    payloadMsgs = filtered;
  }

  const subject = records[0].get("subject") || "";
  const prompts = buildPrompts(
    subject,
    lang,
    payloadMsgs,
    useIncremental ? existing.get("content") : "",
    kind
  );

  const html = generateBriefHtml(prompts.system, prompts.user, kind);

  const newest = records[records.length - 1];
  let rec = existing;
  let isNew = false;
  if (!rec) {
    const collection = $app.findCollectionByNameOrId("thread_briefs");
    rec = new Record(collection);
    rec.set("user", authRecord.id);
    rec.set("thread_id", threadId);
    isNew = true;
  }
  rec.set("content", html);
  rec.set("message_count", records.length);
  rec.set("last_message_id", newest.id);
  rec.set("last_message_date", newest.get("date"));
  $app.save(rec);

  return e.json(200, {
    status: isNew ? "created" : "updated",
    brief: serializeBrief(rec),
  });
}, $apis.requireAuth());

// ===========================================================================
// API: delete the AI note for a thread
// ===========================================================================
routerAdd("DELETE", "/api/mail/thread/{threadId}/brief", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const threadId = e.request.pathValue("threadId");
  if (!threadId) {
    throw new BadRequestError("threadId is required");
  }

  const rec = findBrief($app, authRecord.id, threadId);
  if (!rec) {
    return e.json(200, { status: "deleted", already_deleted: true });
  }

  $app.delete(rec);
  return e.json(200, { status: "deleted" });
}, $apis.requireAuth());

// ===========================================================================
// API: list all AI notes for the user (discovery)
// ===========================================================================
routerAdd("GET", "/api/mail/briefs", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  let records = [];
  try {
    records = $app.findRecordsByFilter(
      "thread_briefs",
      "user = {:uid}",
      "-updated",
      200,
      0,
      { uid: authRecord.id }
    );
  } catch (_) {}

  const items = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    items.push({
      id: r.id,
      thread_id: r.get("thread_id"),
      snippet: plain(r.get("content"), 200),
      message_count: r.get("message_count"),
      last_message_date: r.get("last_message_date"),
      updated: r.get("updated"),
    });
  }

  return e.json(200, { briefs: items });
}, $apis.requireAuth());

// ===========================================================================
// API: thread "context pack" = messages + AI brief in a single round-trip.
// Designed for an external agent: one call returns enough context to decide.
// ===========================================================================
routerAdd("GET", "/api/mail/thread/{threadId}/context", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    throw new ForbiddenError("Authentication required");
  }

  const threadId = e.request.pathValue("threadId");
  if (!threadId) {
    throw new BadRequestError("threadId is required");
  }

  let records = [];
  try {
    records = loadThreadMessages($app, threadId, authRecord.id);
  } catch (_) {}

  const messages = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    messages.push({
      id: r.id,
      account: r.get("account"),
      folder: r.get("folder"),
      message_id: r.get("message_id"),
      in_reply_to: r.get("in_reply_to"),
      from: r.get("from_address"),
      to: r.get("to_addresses"),
      cc: r.get("cc_addresses"),
      subject: r.get("subject"),
      text_body: r.get("text_body"),
      html_body: r.get("html_body"),
      date: r.get("date"),
      is_read: r.get("is_read"),
      is_starred: r.get("is_starred"),
      is_answered: r.get("is_answered"),
      has_attachments: r.get("has_attachments"),
      attachments: r.get("attachments"),
      labels: r.get("labels"),
    });
  }

  let brief = null;
  const briefRec = findBrief($app, authRecord.id, threadId);
  if (briefRec) {
    brief = {
      id: briefRec.id,
      thread_id: briefRec.get("thread_id"),
      content: briefRec.get("content"),
      message_count: briefRec.get("message_count"),
      last_message_id: briefRec.get("last_message_id"),
      last_message_date: briefRec.get("last_message_date"),
      created: briefRec.get("created"),
      updated: briefRec.get("updated"),
    };
  }

  return e.json(200, {
    thread_id: threadId,
    message_count: messages.length,
    messages: messages,
    brief: brief,
  });
}, $apis.requireAuth());
