/**
 * Gabarit du recapitulatif du matin (daily-digest.ts) : HTML en blocs + version
 * texte construite depuis les MEMES donnees. Module PUR (aucune dependance) :
 * teste seul et rendu tel quel par le script d'apercu.
 *
 * Regles de mise en page (courriel lisible dans Gmail, Outlook, telephone) :
 * tableaux imbriques, styles EN LIGNE, 600 px max, aucune <style>/@media/flex/
 * grid/var(--), pictogrammes PNG heberges (jamais SVG ni data:), tout texte
 * venu de l'exterieur echappe. Le sujet n'est PAS du HTML (jamais echappe).
 *
 * Les textes francais sont ecrits avec des echappements \u pour garder le
 * source en ASCII (convention du projet) tout en envoyant des accents.
 */

export type MailKind = "client" | "relance" | "facturation" | "important";

export interface DigestMailItem {
  senderName: string;
  senderAddress: string;
  subject: string;
  summary: string;
  kind: MailKind;
  url: string;
}

export interface DigestNewsletterItem {
  title: string;
  source: string;
  summary: string;
  alert: string;
  url: string;
}

export interface DigestTrackingItem {
  title: string;
  status: string;
  /** "moved" = a bouge la veille ; "awaiting" = attend votre reponse. */
  reason: "moved" | "awaiting";
  detail: string;
  url: string;
}

export interface DigestTrend {
  tag: string;
  delta: number;
  count: number;
}

export interface DailyDigestData {
  /** Jour resume (AAAA-MM-JJ, Paris). */
  day: string;
  appUrl: string;
  mails: DigestMailItem[];
  /** Mails importants non affiches (au-dela du plafond). */
  moreMails: number;
  newsletters: DigestNewsletterItem[];
  newsletterTotal: number;
  tracking: DigestTrackingItem[];
  /** Lundi uniquement : sujets qui montent sur la semaine ecoulee. */
  trends: DigestTrend[] | null;
  trendsTotal: number;
}

export interface DailyDigestContent {
  subject: string;
  html: string;
  text: string;
  empty: boolean;
}

export function esc(s: string): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/** "samedi 14 novembre" depuis "2026-11-14". */
export function frLongDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

const KIND_LABEL: Record<MailKind, string> = {
  client: "Client",
  relance: "Relance",
  facturation: "Facturation",
  important: "Important",
};
const KIND_COLORS: Record<MailKind, { bg: string; fg: string }> = {
  client: { bg: "#e0ecff", fg: "#1d4ed8" },
  relance: { bg: "#fde8e8", fg: "#b91c1c" },
  facturation: { bg: "#e3f6ec", fg: "#047857" },
  important: { bg: "#f1f2f5", fg: "#374151" },
};

/** Teinte du carre de pictogramme par rubrique (le pictogramme lui-meme est fonce). */
const SECTION = {
  mails: { icon: "mail", tint: "#e8f0fe", title: "Mails importants non lus" },
  newsletters: { icon: "newsletter", tint: "#f1ebfe", title: "Dans vos newsletters" },
  tracking: { icon: "tracking", tint: "#fdf3e1", title: "Vos suivis" },
  trends: { icon: "trending", tint: "#e6f6ee", title: "Sujets qui montent cette semaine" },
} as const;

const T = {
  surtitle: "Récapitulatif du matin",
  nothing: "Rien d'important hier",
  nothingText:
    "Aucun mail important en attente, aucune nouvelle marquante dans vos newsletters et aucun suivi qui demande votre attention.",
  open: "Ouvrir iMiel",
  openInbox: "Ouvrir ma boîte",
  fallback: "Le bouton ne s'ouvre pas ?",
  footer:
    "Vous recevez ce récapitulatif chaque matin à 7 h. Pour l'arrêter : Réglages, onglet Notifications.",
  settings: "Gérer ce mail",
  awaiting: "Attend votre réponse",
  moved: "A bougé hier",
  moreMails: (n: number) => `Et ${plural(n, "autre mail important", "autres mails importants")} dans votre boîte.`,
  moreNewsletters: (n: number) => `${plural(n, "newsletter reçue", "newsletters reçues")} hier au total.`,
  trendsLine: (n: number) => `Calculé sur ${plural(n, "newsletter", "newsletters")} reçues la semaine dernière.`,
  dayTitle: (day: string) => `Votre journée du ${frLongDay(day)}`,
};

/** Adresse publique d'un pictogramme (PNG servi par le frontend). */
export function iconUrl(appUrl: string, name: string): string {
  return `${appUrl}/images/digest/${name}.png`;
}

function sectionHeader(appUrl: string, key: keyof typeof SECTION, count: number | null): string {
  const s = SECTION[key];
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="40" style="width:40px;min-width:40px;padding:0 12px 0 0;" valign="middle">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="40" height="40" align="center" valign="middle" bgcolor="${s.tint}" style="width:40px;height:40px;border-radius:10px;background-color:${s.tint};">` +
    `<img src="${esc(iconUrl(appUrl, s.icon))}" width="22" height="22" alt="" style="display:block;border:0;width:22px;height:22px;"></td></tr></table></td>` +
    `<td valign="middle" style="font-size:16px;line-height:22px;font-weight:bold;color:#111827;">${esc(s.title)}</td>` +
    (count !== null
      ? `<td valign="middle" align="right" style="padding-left:8px;"><span style="display:inline-block;padding:2px 10px;border-radius:999px;background-color:#f3f4f6;font-size:13px;line-height:20px;font-weight:bold;color:#374151;">${count}</span></td>`
      : "") +
    `</tr></table>`
  );
}

function card(inner: string): string {
  return (
    `<tr><td style="padding:0 24px 16px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:14px;">` +
    `<tr><td style="padding:16px 18px 6px 18px;">${inner}</td></tr></table></td></tr>`
  );
}

function badge(label: string, bg: string, fg: string): string {
  return `<span style="display:inline-block;padding:1px 8px;border-radius:999px;background-color:${bg};font-size:11px;line-height:18px;font-weight:bold;color:${fg};white-space:nowrap;">${esc(label)}</span>`;
}

/** Une ligne cliquable : titre en gras (lien), badge, ligne secondaire, resume. */
function row(opts: { title: string; url: string; badge?: string; meta?: string; summary?: string; first: boolean }): string {
  const border = opts.first ? "" : "border-top:1px solid #eef0f3;";
  return (
    `<tr><td style="${border}padding:12px 0;word-break:break-word;overflow-wrap:anywhere;">` +
    `<a href="${esc(opts.url)}" style="font-size:15px;line-height:21px;font-weight:bold;color:#111827;text-decoration:none;">${esc(opts.title)}</a>` +
    (opts.badge ? `&nbsp; ${opts.badge}` : "") +
    (opts.meta ? `<div style="font-size:13px;line-height:19px;color:#6b7280;padding-top:2px;">${esc(opts.meta)}</div>` : "") +
    (opts.summary ? `<div style="font-size:14px;line-height:20px;color:#374151;padding-top:4px;">${esc(opts.summary)}</div>` : "") +
    `</td></tr>`
  );
}

function rows(inner: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${inner.join("")}</table>`;
}

function note(text: string): string {
  return `<p style="margin:0 0 12px 0;font-size:13px;line-height:19px;color:#6b7280;">${esc(text)}</p>`;
}

export function buildSubject(d: DailyDigestData): string {
  const parts: string[] = [];
  const nMails = d.mails.length + d.moreMails;
  if (nMails) parts.push(plural(nMails, "mail important", "mails importants"));
  if (d.tracking.length) parts.push(plural(d.tracking.length, "suivi", "suivis"));
  if (d.newsletters.length) parts.push(plural(d.newsletters.length, "nouvelle", "nouvelles"));
  if (!parts.length) return d.trends?.length ? `Votre semaine : ${d.trends.slice(0, 3).map((t) => t.tag).join(", ")} en hausse` : T.nothing;
  return `Votre journée d'hier : ${parts.join(", ")}`;
}

export function buildDailyDigestContent(d: DailyDigestData): DailyDigestContent {
  const app = d.appUrl.replace(/\/+$/, "");
  const inboxUrl = `${app}/#/mail/inbox`;
  const settingsUrl = `${app}/#/settings?tab=notifications`;
  const hasTrends = !!d.trends && d.trends.length > 0;
  const empty = !d.mails.length && !d.newsletters.length && !d.tracking.length && !d.moreMails;
  const subject = buildSubject(d);
  const title = empty ? T.nothing : T.dayTitle(d.day);

  const summaryBits: string[] = [];
  if (d.mails.length + d.moreMails) summaryBits.push(plural(d.mails.length + d.moreMails, "mail important", "mails importants"));
  if (d.tracking.length) summaryBits.push(plural(d.tracking.length, "suivi", "suivis"));
  if (d.newsletters.length) summaryBits.push(plural(d.newsletters.length, "nouvelle", "nouvelles"));
  const lead = empty ? `${T.dayTitle(d.day)}. ${T.nothingText}` : summaryBits.join(" · ");

  // --- Blocs HTML ---
  const blocks: string[] = [];
  const text: string[] = [T.surtitle.toUpperCase(), title, "", lead, ""];

  if (empty) {
    blocks.push(
      card(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td width="40" style="width:40px;min-width:40px;padding:0 12px 10px 0;" valign="top"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="40" height="40" align="center" valign="middle" bgcolor="#e6f6ee" style="width:40px;height:40px;border-radius:10px;background-color:#e6f6ee;">` +
          `<img src="${esc(iconUrl(app, "check"))}" width="22" height="22" alt="" style="display:block;border:0;width:22px;height:22px;"></td></tr></table></td>` +
          `<td valign="top" style="padding-bottom:10px;font-size:14px;line-height:21px;color:#374151;">${esc(T.nothingText)}</td></tr></table>`
      )
    );
  }

  if (d.mails.length || d.moreMails) {
    const r = d.mails.map((m, i) =>
      row({
        title: m.senderName || m.senderAddress,
        url: m.url,
        badge: badge(KIND_LABEL[m.kind], KIND_COLORS[m.kind].bg, KIND_COLORS[m.kind].fg),
        meta: m.subject,
        summary: m.summary,
        first: i === 0,
      })
    );
    blocks.push(card(sectionHeader(app, "mails", d.mails.length + d.moreMails) + rows(r) + (d.moreMails ? note(T.moreMails(d.moreMails)) : "")));
    text.push(`${SECTION.mails.title.toUpperCase()} (${d.mails.length + d.moreMails})`);
    for (const m of d.mails) {
      text.push(`- [${KIND_LABEL[m.kind]}] ${m.senderName || m.senderAddress} : ${m.subject}`);
      if (m.summary) text.push(`  ${m.summary}`);
      text.push(`  ${m.url}`);
    }
    if (d.moreMails) text.push(T.moreMails(d.moreMails));
    text.push("");
  }

  if (d.tracking.length) {
    const r = d.tracking.map((t, i) =>
      row({
        title: t.title,
        url: t.url,
        badge:
          t.reason === "awaiting"
            ? badge(T.awaiting, "#fdf3e1", "#92400e")
            : badge(T.moved, "#e8f0fe", "#1d4ed8"),
        meta: t.status,
        summary: t.detail,
        first: i === 0,
      })
    );
    blocks.push(card(sectionHeader(app, "tracking", d.tracking.length) + rows(r)));
    text.push(`${SECTION.tracking.title.toUpperCase()} (${d.tracking.length})`);
    for (const t of d.tracking) {
      text.push(`- ${t.title} [${t.reason === "awaiting" ? T.awaiting : T.moved}]${t.status ? ` - ${t.status}` : ""}`);
      if (t.detail) text.push(`  ${t.detail}`);
      text.push(`  ${t.url}`);
    }
    text.push("");
  }

  if (d.newsletters.length) {
    const r = d.newsletters.map((n, i) =>
      row({
        title: n.title,
        url: n.url,
        badge: n.alert ? badge(n.alert, "#f1ebfe", "#6d28d9") : undefined,
        meta: n.source,
        summary: n.summary,
        first: i === 0,
      })
    );
    const extra = d.newsletterTotal > d.newsletters.length ? note(T.moreNewsletters(d.newsletterTotal)) : "";
    blocks.push(card(sectionHeader(app, "newsletters", d.newsletters.length) + rows(r) + extra));
    text.push(`${SECTION.newsletters.title.toUpperCase()} (${d.newsletters.length})`);
    for (const n of d.newsletters) {
      text.push(`- ${n.title}${n.source ? ` (${n.source})` : ""}${n.alert ? ` [${n.alert}]` : ""}`);
      if (n.summary) text.push(`  ${n.summary}`);
      text.push(`  ${n.url}`);
    }
    if (extra) text.push(T.moreNewsletters(d.newsletterTotal));
    text.push("");
  }

  if (hasTrends) {
    const statsUrl = `${app}/#/newsletters/stats`;
    const r = d.trends!.slice(0, 5).map(
      (t, i) =>
        `<tr><td style="${i ? "border-top:1px solid #eef0f3;" : ""}padding:9px 0;font-size:14px;line-height:20px;color:#1f2937;word-break:break-word;overflow-wrap:anywhere;">${esc(t.tag)}</td>` +
        `<td align="right" style="${i ? "border-top:1px solid #eef0f3;" : ""}padding:9px 0 9px 12px;font-size:14px;font-weight:bold;color:#047857;white-space:nowrap;">+${t.delta} (${t.count})</td></tr>`
    );
    blocks.push(
      card(
        sectionHeader(app, "trends", null) +
          rows(r) +
          `<p style="margin:0 0 12px 0;font-size:13px;line-height:19px;color:#6b7280;">${esc(T.trendsLine(d.trendsTotal))} <a href="${esc(statsUrl)}" style="color:#6d28d9;">Voir les statistiques</a></p>`
      )
    );
    text.push(SECTION.trends.title.toUpperCase());
    for (const t of d.trends!.slice(0, 5)) text.push(`- ${t.tag} : +${t.delta} (${t.count})`);
    text.push(T.trendsLine(d.trendsTotal), `Voir les statistiques : ${statsUrl}`, "");
  }

  text.push(`${T.openInbox} : ${inboxUrl}`, "", T.footer, `${T.settings} : ${settingsUrl}`);

  const html =
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f4f6;">${esc(lead)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;">` +
    // Entete : marque a gauche, lien discret a droite.
    `<tr><td style="padding:20px 24px 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    // Logo iMiel (image originale detouree, servie par l'app) + nom.
    `<td style="font-size:16px;line-height:22px;font-weight:bold;color:#111827;">` +
    `<img src="${esc(`${app}/icons/imiel-logo-120.png`)}" width="24" height="24" alt="" style="display:inline-block;border:0;width:24px;height:24px;vertical-align:middle;margin-right:8px;">` +
    `<span style="vertical-align:middle;">iMiel</span></td>` +
    `<td align="right" style="font-size:13px;line-height:22px;"><a href="${esc(inboxUrl)}" style="color:#6b7280;text-decoration:none;">${esc(T.open)} &rarr;</a></td>` +
    `</tr></table></td></tr>` +
    // Surtitre + titre + ligne de synthese.
    `<tr><td style="padding:18px 24px 18px 24px;">` +
    `<p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#6d28d9;font-weight:bold;">${esc(T.surtitle)}</p>` +
    `<h1 style="margin:6px 0 6px 0;font-size:23px;line-height:30px;color:#111827;">${esc(title)}</h1>` +
    `<p style="margin:0;font-size:14px;line-height:20px;color:#4b5563;">${esc(empty ? frLongDay(d.day).replace(/^./, (c) => c.toUpperCase()) : lead)}</p></td></tr>` +
    blocks.join("") +
    // Bouton principal + adresse en clair.
    `<tr><td style="padding:4px 24px 8px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#6d28d9" style="border-radius:10px;background-color:#6d28d9;">` +
    `<a href="${esc(inboxUrl)}" style="display:block;padding:12px 22px;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(T.openInbox)}</a></td></tr></table>` +
    `<p style="margin:8px 0 0 0;font-size:12px;line-height:18px;color:#6b7280;">${esc(T.fallback)} <a href="${esc(inboxUrl)}" style="color:#6b7280;word-break:break-all;">${esc(inboxUrl)}</a></p></td></tr>` +
    `<tr><td style="padding:16px 24px 24px 24px;font-size:12px;line-height:18px;color:#9ca3af;">${esc(T.footer)} <a href="${esc(settingsUrl)}" style="color:#9ca3af;">${esc(T.settings)}</a></td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject, html, text: text.join("\n"), empty };
}
