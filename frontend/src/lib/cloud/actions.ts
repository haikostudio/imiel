// Gestes sur le courrier en mode iMiel Cloud : appliques sur la copie locale
// tout de suite, puis chez le fournisseur par le serveur de transfert (qui les
// annonce aux autres appareils). Aucun releveur local n'y prend part.
import pb from "@/lib/pocketbase";
import { cloud, cloudBinaire } from "./client";
import { synchroniser } from "./sync";

interface MessageLocal {
  id: string;
  account: string;
  uid: number;
  folder: string;
  is_draft?: boolean;
  expand?: { folder?: { path: string; type: string } };
}

async function lireMessage(id: string): Promise<MessageLocal> {
  return pb.collection("messages").getOne<MessageLocal & import("pocketbase").RecordModel>(id, {
    expand: "folder",
    fields: "id,account,uid,folder,is_draft,expand.folder.path,expand.folder.type",
  });
}

async function geste(action: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await cloud<{ resultats: { ok: boolean; erreur?: string }[] }>("POST", "/v1/actions", { actions: [action] });
  const x = r.resultats[0];
  if (!x?.ok) throw new Error(x?.erreur || "Le fournisseur a refuse ce geste.");
  return x as unknown as Record<string, unknown>;
}

export async function cloudDrapeaux(id: string, flags: { is_read?: boolean; is_starred?: boolean; is_answered?: boolean }): Promise<void> {
  const m = await lireMessage(id);
  await pb.collection("messages").update(id, flags);
  if (!m.uid || m.is_draft || !m.expand?.folder) return;
  await geste({ type: "drapeaux", boite: m.account, dossier: m.expand.folder.path, uid: m.uid, lu: flags.is_read, favori: flags.is_starred, repondu: flags.is_answered });
}

/** Deplacer : chez le fournisseur le mail change d'UID, il revient par la synchro du dossier cible. */
export async function cloudDeplacer(id: string, folderId: string): Promise<void> {
  const m = await lireMessage(id);
  const cible = await pb.collection("folders").getOne(folderId, { fields: "id,path" });
  if (!m.uid || m.is_draft || !m.expand?.folder) {
    await pb.collection("messages").update(id, { folder: folderId });
    return;
  }
  await geste({ type: "deplacer", boite: m.account, dossier: m.expand.folder.path, uid: m.uid, vers: cible.path });
  await pb.collection("messages").delete(id).catch(() => {});
  void synchroniser();
}

export async function cloudSupprimer(id: string): Promise<void> {
  const m = await lireMessage(id);
  if (m.uid && !m.is_draft && m.expand?.folder) {
    await geste({ type: "supprimer", boite: m.account, dossier: m.expand.folder.path, uid: m.uid });
  }
  await pb.collection("messages").delete(id).catch(() => {});
}

/** Mise a jour generique (equivalent de /worker/message-update) : deplacement chez le fournisseur, le reste en local. */
export async function cloudMiseAJour(id: string, data: Record<string, unknown>): Promise<void> {
  const { folder, is_read, is_starred, is_answered, ...reste } = data as {
    folder?: string;
    is_read?: boolean;
    is_starred?: boolean;
    is_answered?: boolean;
  } & Record<string, unknown>;
  if (Object.keys(reste).length) await pb.collection("messages").update(id, reste);
  if (is_read !== undefined || is_starred !== undefined || is_answered !== undefined) {
    await cloudDrapeaux(id, { ...(is_read !== undefined ? { is_read } : {}), ...(is_starred !== undefined ? { is_starred } : {}), ...(is_answered !== undefined ? { is_answered } : {}) });
  }
  if (folder) await cloudDeplacer(id, folder);
}

function enBase64(b: Blob): Promise<string> {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => ko(r.error);
    r.readAsDataURL(b);
  });
}

type Adresse = { name?: string; address: string };
const liste = (v: unknown): string[] =>
  (Array.isArray(v) ? (v as Adresse[]) : []).filter((a) => a?.address).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));

/** Envoi d'un brouillon local par le serveur de transfert (SMTP du fournisseur). */
export async function cloudEnvoyer(accountId: string, messageId: string, files?: File[]): Promise<{ status: string; message_id?: string }> {
  const d = await pb.collection("messages").getOne(messageId);
  const pieces: { nom: string; type: string; base64: string; cid?: string }[] = [];
  const locales = await pb.collection("attachments").getFullList({ filter: `message="${messageId}"` }).catch(() => []);
  for (const a of locales) {
    if (!a.file) continue;
    const blob = await (await fetch(pb.files.getURL(a, a.file))).blob();
    pieces.push({ nom: a.filename, type: a.content_type || blob.type || "application/octet-stream", base64: await enBase64(blob), ...(a.content_id ? { cid: String(a.content_id).replace(/^<|>$/g, "") } : {}) });
  }
  for (const f of files || []) pieces.push({ nom: f.name, type: f.type || "application/octet-stream", base64: await enBase64(f) });
  const r = await cloud<{ ok: boolean; messageId?: string }>("POST", "/v1/envoyer", {
    boite: accountId,
    mail: {
      to: liste(d.to_addresses),
      cc: liste(d.cc_addresses),
      bcc: liste(d.bcc_addresses),
      subject: d.subject || "",
      html: d.html_body || undefined,
      text: d.text_body || undefined,
      inReplyTo: d.in_reply_to || undefined,
      references: Array.isArray(d.references) && d.references.length ? d.references.join(" ") : undefined,
      priority: d.priority && d.priority !== "normal" ? d.priority : undefined,
      pieces,
    },
  });
  // Le brouillon local s'efface : la copie envoyee revient par la synchro du
  // dossier « Envoyes ». Le mail auquel on repond passe en « repondu ».
  if (d.in_reply_to) {
    const orig = await pb
      .collection("messages")
      .getFirstListItem(`account="${accountId}" && message_id="${String(d.in_reply_to).replace(/"/g, '\\"')}"`)
      .catch(() => null);
    if (orig) await cloudDrapeaux(orig.id, { is_answered: true }).catch(() => {});
  }
  await pb.collection("messages").delete(messageId).catch(() => {});
  void synchroniser();
  return { status: "sent", message_id: r.messageId || "" };
}

/** Pieces jointes d'un brouillon, rangees dans la base locale (sans releveur). */
export async function cloudPiecesBrouillon(
  messageId: string,
  files: File[],
  inline = false
): Promise<{ id: string; filename: string; size: number; file?: string; content_id?: string; is_inline?: boolean }[]> {
  const fd = new FormData();
  fd.append("messageId", messageId);
  if (inline) fd.append("inline", "1");
  for (const f of files) fd.append("files", f);
  const r = await pb.send("/api/cloud/piece-brouillon", { method: "POST", body: fd });
  return r.attachments || [];
}

// --- Pieces jointes lues a la demande chez le fournisseur ---------------------
export const PREFIXE_PIECE = "imiel-cloud:";
const cache = new Map<string, Promise<string>>();

/** Adresse locale (blob:) du contenu d'une piece jointe iMiel Cloud. */
export function urlPiece(adresse: string): Promise<string> {
  const id = adresse.startsWith(PREFIXE_PIECE) ? adresse.slice(PREFIXE_PIECE.length) : adresse;
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      const a = await pb.collection("attachments").getOne(id, { fields: "id,message,cloud_index" });
      const m = await lireMessage(a.message);
      const q = new URLSearchParams({ boite: m.account, dossier: m.expand?.folder?.path || "", uid: String(m.uid), index: String(a.cloud_index ?? 0) });
      return URL.createObjectURL(await cloudBinaire(`/v1/pieces?${q}`));
    })();
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

export async function telechargerPiece(adresse: string, nom: string): Promise<void> {
  const url = await urlPiece(adresse);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
