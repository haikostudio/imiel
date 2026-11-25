import webPush, { PushSubscription, SendResult } from "web-push";
import { sendApns } from "./apns";
import {
  listPushTokensForUser,
  deletePushToken,
  type PBPushToken,
} from "./pocketbase";

let vapidConfigured = false;

function ensureVapidConfigured(): void {
  if (vapidConfigured) return;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required");
  }

  webPush.setVapidDetails("https://imiel.example.com", publicKey, privateKey);
  vapidConfigured = true;
}

function tokenToSubscription(token: PBPushToken): PushSubscription {
  return {
    endpoint: token.endpoint,
    keys: {
      p256dh: token.p256dh,
      auth: token.auth_key,
    },
  };
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  /** URL ouverte au clic (le service worker lit ce champ au niveau racine). */
  url?: string;
  data?: Record<string, unknown>;
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  const allTokens = await listPushTokensForUser(userId);
  if (allTokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  // Application iPhone : meme contenu, via APNs (categorie d'actions, relance
  // des widgets). Les jetons Web Push suivent le chemin historique.
  const apnsTokens = allTokens.filter((t) => t.platform === "apns");
  const tokens = allTokens.filter((t) => t.platform !== "apns");
  let apnsSent = 0;
  let apnsFailed = 0;
  if (apnsTokens.length > 0) {
    const data = (payload.data || {}) as Record<string, unknown>;
    const results = await sendApns(
      apnsTokens.map((t) => t.endpoint),
      {
        title: payload.title,
        body: payload.body,
        collapseId: payload.tag,
        category: typeof data.category === "string" ? data.category : undefined,
        threadId: typeof data.type === "string" ? data.type : undefined,
        data: { url: payload.url || "/", ...data },
      }
    ).catch((err) => {
      console.warn("[apns] send failed:", (err as Error).message);
      return [];
    });
    for (const r of results) {
      if (r.ok) apnsSent++;
      else {
        apnsFailed++;
        if (r.gone) {
          const dead = apnsTokens.find((t) => t.endpoint === r.endpoint);
          if (dead) await deletePushToken(dead.id).catch(() => {});
        } else {
          console.warn(`[apns] ${r.status} ${r.reason || ""}`);
        }
      }
    }
  }
  if (tokens.length === 0) {
    return { sent: apnsSent, failed: apnsFailed };
  }
  ensureVapidConfigured();

  const payloadStr = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const subscription = tokenToSubscription(token);
      try {
        await webPush.sendNotification(subscription, payloadStr);
        sent++;
      } catch (err: unknown) {
        const statusCode = (err as SendResult)?.statusCode;
        // 404 or 410 means subscription is expired/invalid
        if (statusCode === 404 || statusCode === 410) {
          console.log(
            `Push token ${token.id} expired (${statusCode}), removing`
          );
          await deletePushToken(token.id);
        } else {
          console.error(
            `Failed to send push to token ${token.id}:`,
            err
          );
        }
        failed++;
      }
    })
  );

  // Count any unexpected rejections
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Push send promise rejected:", result.reason);
    }
  }

  return { sent: sent + apnsSent, failed: failed + apnsFailed };
}

/**
 * Favicon du domaine de l'expediteur, servi par le proxy Google (PNG 128px).
 * Sert d'icone principale de la notification : le destinataire reconnait la
 * marque/source du mail d'un coup d'oeil. Le service worker garde l'icone de
 * l'app en `badge` (petit, en bas a droite). Repli sur l'icone par defaut du
 * service worker si l'adresse n'a pas de domaine exploitable.
 */
export function senderFaviconUrl(senderAddress?: string): string | undefined {
  if (!senderAddress) return undefined;
  const at = senderAddress.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = senderAddress.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return undefined;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

export async function sendNewEmailNotification(
  userId: string,
  from: string,
  subject: string,
  accountId: string,
  messageId: string,
  threadId?: string,
  senderAddress?: string
): Promise<void> {
  // Deep-link : le clic ouvre la page "Tous les messages" et y selectionne la
  // conversation (params ?t/?m lus par la page mail -> ouvre le drawer mobile +
  // marque lu). On vise `/mail/all` (et non la route plein-ecran
  // `/mail/thread/:id`) : c'est ce que veut l'utilisateur (rester dans la liste)
  // et ca evite les soucis de chargement du thread hors fenetre sur mobile.
  // Sans thread_id, repli sur la liste.
  const url = threadId
    ? `/#/mail/all?t=${encodeURIComponent(threadId)}&m=${encodeURIComponent(messageId)}`
    : "/#/mail/all";
  await sendPushToUser(userId, {
    title: from || "New email",
    body: subject || "(no subject)",
    // Icone principale = favicon du domaine de l'expediteur (le badge app reste
    // gere par le service worker). Si pas de domaine -> defaut du sw.
    icon: senderFaviconUrl(senderAddress),
    tag: `new-email-${accountId}`,
    url,
    data: {
      type: "new_email",
      accountId,
      messageId,
      threadId,
    },
  });
}

/**
 * Notification d'une nouvelle newsletter agregee dans le flux. Le clic ouvre
 * l'onglet Newsletters (deep-link via le champ `url` lu par le service worker).
 */
export async function sendNewsletterNotification(
  userId: string,
  sourceName: string,
  title: string
): Promise<void> {
  // Marqueur visuel (emoji) + libelle "Newsletter" pour distinguer d'un push
  // e-mail classique (qui porte l'expediteur en titre, sans prefixe).
  const source = sourceName || "Newsletter";
  await sendPushToUser(userId, {
    title: `\u{1F4F0} Newsletter - ${source}`,
    body: title || "Nouvelle newsletter agregee dans le flux",
    tag: `newsletter-${userId}`,
    url: "/#/newsletters",
    data: { type: "newsletter" },
  });
}

/**
 * Alerte newsletter : la newsletter aborde un ou plusieurs sujets surveilles
 * par l'utilisateur. UN SEUL push par newsletter (remplace la notif ordinaire).
 */
export async function sendNewsletterAlertNotification(
  userId: string,
  topics: string[],
  sourceName: string,
  title: string,
  postId: string
): Promise<void> {
  const label = topics.join(", ");
  await sendPushToUser(userId, {
    title: `\u{1F514} Alerte ${label}`,
    body: `${sourceName || "Newsletter"} - ${title || "Nouvelle newsletter"}`,
    tag: `newsletter-alert-${postId}`,
    url: "/#/newsletters",
    data: { type: "newsletter" },
  });
}

/**
 * Notification d'un CHANGEMENT DE STATUT d'un suivi (commande, livraison,
 * rendez-vous...). Volontairement DISTINCTE d'un push e-mail classique pour que
 * l'utilisateur reconnaisse au premier coup d'oeil un changement de statut :
 *  - marqueur visuel (cloche) + libelle "Suivi" en titre. Le TITRE s'affiche de
 *    maniere fiable sur toutes les plateformes (y compris iOS, qui ignore
 *    souvent l'icone custom) -> c'est le distingueur principal.
 *  - icone dediee (suivi) pour les plateformes qui l'honorent (desktop/Android).
 * Le clic ouvre l'onglet Suivi. Tag PAR FICHE -> deux changements de statut sur
 * des fiches differentes ne s'ecrasent pas l'un l'autre.
 */
export async function sendTrackingStatusNotification(
  userId: string,
  itemId: string,
  itemTitle: string,
  statusLabel: string
): Promise<void> {
  await sendPushToUser(userId, {
    title: `\u{1F514} Suivi - ${statusLabel}`,
    body: itemTitle || "Statut mis a jour",
    icon: "/icons/tracking-192.png",
    tag: `tracking-status-${itemId}`,
    url: "/#/suivi",
    data: { type: "tracking_status", itemId },
  });
}

/**
 * Notification "echeances detectees" : des dates (livraison, RDV, echeance) ont
 * ete reperees dans le suivi et attendent la decision de l'utilisateur
 * (ajouter a l'agenda / refuser). Le tap ouvre la app sur le Suivi avec le
 * parametre `dates=1` -> le drawer de propositions s'ouvre automatiquement.
 * Calendrier emoji + tag dedie pour la distinguer des notifs de statut. `count`
 * regroupe les detections d'une meme passe en UNE seule notif (pas de rafale).
 */
export async function sendCalendarSuggestionNotification(
  userId: string,
  count: number,
  sample: string
): Promise<void> {
  if (count <= 0) return;
  const plural = count > 1;
  await sendPushToUser(userId, {
    title: `\u{1F4C5} ${count} echeance${plural ? "s" : ""} a ajouter`,
    body: plural
      ? `${sample ? sample + " " : ""}+ ${count - 1} autre${count - 1 > 1 ? "s" : ""} a verifier dans le suivi`
      : sample || "Une date a ajouter a votre agenda",
    icon: "/icons/tracking-192.png",
    tag: "calendar-suggestions",
    url: "/#/suivi?dates=1",
    data: { type: "calendar_suggestions" },
  });
}

/**
 * "Nouvelle invitation" (agenda) : titre, quand, et ligne de conflit calculee
 * sur l'agenda ("Chevauche 11:20 Coiffeur"). `category: INVITATION` porte les
 * actions Accepter / Refuser sur l'iPhone ; le clic ouvre le mail d'origine.
 * Non filtree par le reglage de niveau des mails (decision utilisateur).
 */
export async function sendInvitationNotification(
  userId: string,
  inv: {
    eventId: string;
    kind: "new" | "updated" | "cancelled";
    title: string;
    organizer: string;
    when: string;
    conflict: string;
    url: string;
  }
): Promise<void> {
  const head =
    inv.kind === "cancelled"
      ? "Invitation annulee"
      : inv.kind === "updated"
        ? "Invitation modifiee"
        : "Nouvelle invitation";
  const lines = [
    inv.title,
    [inv.when, inv.organizer ? `par ${inv.organizer}` : ""].filter(Boolean).join(" · "),
    inv.conflict,
  ].filter(Boolean);
  await sendPushToUser(userId, {
    title: `\u{1F4C5} ${head}`,
    body: lines.join("\n"),
    icon: "/icons/calendar-192.png",
    tag: `invitation-${inv.eventId}`,
    url: inv.url,
    data: {
      type: "invitation",
      eventId: inv.eventId,
      kind: inv.kind,
      category: inv.kind === "cancelled" ? undefined : "INVITATION",
    },
  });
}
