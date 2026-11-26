// Lecture d'un mail brut (lu chez le fournisseur) dans la forme des fiches
// iMiel (meme forme que backend/mail-worker/src/parser.ts + imap.ts). Tout se
// passe EN MEMOIRE : rien n'est ecrit sur le disque du serveur.
//
// Les pieces jointes ne voyagent PAS avec le mail : seules leurs metadonnees
// partent (nom, type, taille) ; le contenu est relu chez le fournisseur quand
// l'utilisateur l'ouvre. Exception : les petites images INTEGREES au corps
// (cid:) sont posees dans le HTML en data: pour que le mail s'affiche entier.
import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import { idMail, idPiece } from "../commun/forme.mjs";

const MAX_INTEGREES = 1_500_000; // octets d'images integrees posees dans le HTML

function adresses(champ) {
  if (!champ) return [];
  const liste = Array.isArray(champ) ? champ : [champ];
  const out = [];
  for (const g of liste) for (const a of g.value || []) out.push({ ...(a.name ? { name: a.name } : {}), address: a.address || "" });
  return out;
}

export function texteDepuisHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?\w+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extrait(texte, max = 200) {
  if (!texte) return "";
  const t = texte.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").replace(/^\s+/gm, "").trim();
  return t.length <= max ? t : t.substring(0, max).trim() + "...";
}

/** Meme calcul que backend/mail-worker/src/threading.ts. */
export function idFil(messageId, inReplyTo, references) {
  const ids = (v) => (String(v || "").match(/<[^>]+>/g) || []).map((m) => m.trim());
  const refs = ids(references);
  const racine = refs[0] || ids(inReplyTo)[0] || messageId;
  if (!racine) return crypto.randomUUID();
  return crypto.createHash("sha256").update(String(racine).toLowerCase().trim()).digest("hex").substring(0, 32);
}

function enTetesBruts(source) {
  const s = source.toString("latin1");
  const fin = s.indexOf("\r\n\r\n");
  return (fin > -1 ? s.substring(0, fin) : s.substring(0, 5000)).substring(0, 5000);
}

/**
 * @param {Buffer} source mail brut
 * @param {{ boite: string, chemin: string, uidValidity: number, uid: number, drapeaux?: Set<string>|string[] }} ou
 */
export async function analyserMail(source, ou) {
  const p = await simpleParser(source, { skipTextToHtml: true });
  const drapeaux = new Set(ou.drapeaux || []);
  const id = idMail(ou.boite, ou.chemin, ou.uidValidity, ou.uid);
  const pieces = (p.attachments || []).map((a, index) => ({ a, index }));

  let html = p.html || "";
  let budget = MAX_INTEGREES;
  for (const { a } of pieces) {
    if (!a.cid || !html.includes(`cid:${a.cid}`) || !/^image\//.test(a.contentType || "")) continue;
    if (a.size > budget) continue;
    budget -= a.size;
    html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString("base64")}`);
  }
  const texte = p.text || "";
  const references = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const from = p.from?.value?.[0];
  return {
    id,
    uid: ou.uid,
    message_id: p.messageId || "",
    thread_id: idFil(p.messageId, p.inReplyTo, references.join(" ")),
    subject: p.subject || "(no subject)",
    from_address: { ...(from?.name ? { name: from.name } : {}), address: from?.address || "" },
    to_addresses: adresses(p.to),
    cc_addresses: adresses(p.cc),
    bcc_addresses: adresses(p.bcc),
    date: (p.date || new Date()).toISOString(),
    snippet: extrait(texte || texteDepuisHtml(html)),
    text_body: texte,
    html_body: html,
    is_read: drapeaux.has("\\Seen"),
    is_starred: drapeaux.has("\\Flagged"),
    is_answered: drapeaux.has("\\Answered"),
    is_draft: drapeaux.has("\\Draft"),
    has_attachments: pieces.some(({ a }) => a.contentDisposition !== "inline"),
    references,
    in_reply_to: p.inReplyTo || "",
    raw_headers: enTetesBruts(source),
    pieces: pieces.map(({ a, index }) => ({
      id: idPiece(id, index),
      index,
      filename: a.filename || (String(a.contentType).includes("calendar") ? "invite.ics" : "attachment"),
      content_type: a.contentType || "application/octet-stream",
      size: a.size || 0,
      content_id: a.contentId || "",
      is_inline: a.contentDisposition === "inline",
    })),
  };
}

/** Contenu d'une piece jointe (lue a la demande, en memoire). */
export async function extrairePiece(source, index) {
  const p = await simpleParser(source, { skipTextToHtml: true, skipHtmlToText: true });
  const a = (p.attachments || [])[Number(index)];
  if (!a) return null;
  return { nom: a.filename || "piece-jointe", type: a.contentType || "application/octet-stream", contenu: a.content };
}
