// Fournisseurs de messagerie connus : reglages IMAP/SMTP prets a l'emploi pour
// la carte "Ajouter un compte" de l'assistant IA. Reconnus par le nom donne
// (« Infomaniak »), par le domaine de l'adresse (gmail.com) ou par les serveurs
// MX du domaine (un domaine perso heberge chez Infomaniak : mta-gw.infomaniak.ch).

export type Security = "none" | "ssl" | "starttls";

export interface MailProvider {
  key: string;
  name: string;
  imap: { host: string; port: number; security: Security };
  smtp: { host: string; port: number; security: Security };
  /** Connexion par le bouton Google (OAuth) plutot que par mot de passe. */
  oauth?: "google";
  /** Mots reconnus dans la demande ("infomaniak", "ik.me"...). */
  aliases: string[];
  /** Domaines d'adresse grand public de ce fournisseur. */
  domains: string[];
  /** Fragments de serveur MX qui designent ce fournisseur. */
  mx: string[];
  /** Mise en garde a montrer dans la carte. */
  note?: string;
}

const ssl = (host: string, port = 993) => ({ host, port, security: "ssl" as const });
const tls = (host: string, port = 587) => ({ host, port, security: "starttls" as const });
// Envoi : 587 STARTTLS partout ou le fournisseur l'accepte. Le serveur du
// worker (Hetzner) bloque le port 465 en sortie : un compte en 465 SSL
// echoue en "delai d'attente depasse" (tous les comptes en service sont en 587).

export const MAIL_PROVIDERS: MailProvider[] = [
  {
    key: "infomaniak", name: "Infomaniak",
    imap: ssl("mail.infomaniak.com"), smtp: tls("mail.infomaniak.com"),
    aliases: ["infomaniak", "ik.me", "kmail"], domains: ["ik.me", "cabinet.com", "ikmail.com"], mx: ["infomaniak"],
  },
  {
    key: "gmail", name: "Gmail / Google Workspace",
    imap: ssl("imap.gmail.com"), smtp: tls("smtp.gmail.com"), oauth: "google",
    aliases: ["gmail", "google", "workspace", "gsuite"], domains: ["gmail.com", "googlemail.com"], mx: ["google.com", "googlemail.com"],
  },
  {
    key: "outlook", name: "Outlook / Microsoft 365",
    imap: ssl("outlook.office365.com"), smtp: tls("smtp.office365.com"),
    aliases: ["outlook", "hotmail", "live", "microsoft", "office365", "office 365", "m365"],
    domains: ["outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr", "msn.com"], mx: ["outlook.com"],
    note: "Microsoft refuse souvent le mot de passe simple : il peut falloir un mot de passe d'application.",
  },
  {
    key: "icloud", name: "iCloud",
    imap: ssl("imap.mail.me.com"), smtp: tls("smtp.mail.me.com"),
    aliases: ["icloud", "apple"], domains: ["icloud.com", "me.com", "mac.com"], mx: ["icloud.com"],
    note: "iCloud exige un mot de passe d'application (appleid.apple.com).",
  },
  {
    key: "ovh", name: "OVHcloud",
    imap: ssl("ssl0.ovh.net"), smtp: tls("ssl0.ovh.net"),
    aliases: ["ovh", "ovhcloud"], domains: [], mx: ["ovh.net"],
  },
  {
    key: "gandi", name: "Gandi",
    imap: ssl("mail.gandi.net"), smtp: tls("mail.gandi.net"),
    aliases: ["gandi"], domains: [], mx: ["gandi.net"],
  },
  {
    key: "ionos", name: "IONOS",
    imap: ssl("imap.ionos.fr"), smtp: tls("smtp.ionos.fr"),
    aliases: ["ionos", "1and1", "1&1"], domains: [], mx: ["ionos", "1and1", "kundenserver"],
  },
  {
    key: "hostinger", name: "Hostinger",
    imap: ssl("imap.hostinger.com"), smtp: tls("smtp.hostinger.com"),
    aliases: ["hostinger"], domains: [], mx: ["hostinger"],
  },
  {
    key: "zoho", name: "Zoho Mail",
    imap: ssl("imap.zoho.eu"), smtp: tls("smtp.zoho.eu"),
    aliases: ["zoho"], domains: ["zohomail.eu", "zoho.eu"], mx: ["zoho"],
  },
  {
    key: "yahoo", name: "Yahoo",
    imap: ssl("imap.mail.yahoo.com"), smtp: tls("smtp.mail.yahoo.com"),
    aliases: ["yahoo"], domains: ["yahoo.com", "yahoo.fr", "ymail.com"], mx: ["yahoodns"],
    note: "Yahoo exige un mot de passe d'application.",
  },
  {
    key: "orange", name: "Orange",
    imap: ssl("imap.orange.fr"), smtp: tls("smtp.orange.fr"),
    aliases: ["orange", "wanadoo"], domains: ["orange.fr", "wanadoo.fr"], mx: ["orange.fr"],
  },
  {
    key: "free", name: "Free",
    imap: ssl("imap.free.fr"), smtp: tls("smtp.free.fr"),
    aliases: ["free"], domains: ["free.fr"], mx: ["free.fr"],
  },
  {
    key: "sfr", name: "SFR",
    imap: ssl("imap.sfr.fr"), smtp: tls("smtp.sfr.fr"),
    aliases: ["sfr", "neuf"], domains: ["sfr.fr", "neuf.fr"], mx: ["sfr.fr"],
  },
  {
    key: "laposte", name: "La Poste",
    imap: ssl("imap.laposte.net"), smtp: tls("smtp.laposte.net"),
    aliases: ["laposte", "la poste"], domains: ["laposte.net"], mx: ["laposte.net"],
  },
  {
    key: "proton", name: "Proton Mail (Bridge)",
    imap: tls("127.0.0.1", 1143), smtp: tls("127.0.0.1", 1025),
    aliases: ["proton", "protonmail"], domains: ["proton.me", "protonmail.com", "pm.me"], mx: ["protonmail"],
    note: "Proton ne fonctionne qu'au travers de Proton Bridge, qui doit tourner sur une machine joignable.",
  },
];

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

/** Fournisseur designe par son nom (ou un alias) dans la demande. */
export function providerByName(name: string): MailProvider | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return MAIL_PROVIDERS.find((p) => p.key === n || norm(p.name) === n || p.aliases.some((a) => n === a || n.includes(a)));
}

/** Fournisseur grand public deduit du domaine de l'adresse. */
export function providerByEmail(email: string): MailProvider | undefined {
  const domain = norm(email.split("@")[1] || "");
  if (!domain) return undefined;
  return MAIL_PROVIDERS.find((p) => p.domains.includes(domain));
}

/** Fournisseur deduit des serveurs MX du domaine. */
export function providerByMx(mxHosts: string[]): MailProvider | undefined {
  const hosts = mxHosts.map(norm);
  return MAIL_PROVIDERS.find((p) => p.mx.some((frag) => hosts.some((h) => h.includes(frag))));
}
