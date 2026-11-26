// Detection automatique des reglages d'une boite a partir de son adresse :
// l'utilisateur ne tape que son adresse et son mot de passe.
//
// Ordre (le premier qui repond gagne) :
//   1. fournisseurs connus (Gmail et Outlook passent par « Se connecter avec... »,
//      iCloud et Yahoo exigent un mot de passe d'application) ;
//   2. base ISPDB de Thunderbird (autoconfig.thunderbird.net) ;
//   3. autoconfig du domaine (autoconfig.<domaine>, puis .well-known) ;
//   4. enregistrements SRV (RFC 6186 : _imaps._tcp, _submission._tcp) ;
//   5. serveurs MX : Google Workspace, Microsoft 365, Infomaniak, OVH... ;
//   6. repli : imap.<domaine> / smtp.<domaine>.
// Envoi : toujours 587 STARTTLS quand le fournisseur le permet (le 465 est
// souvent bloque depuis les serveurs).
import dns from "node:dns/promises";

const imap = (host, port = 993, security = "ssl") => ({ host, port, security });
const smtp = (host, port = 587, security = "starttls") => ({ host, port, security });

export const GOOGLE = { fournisseur: "google", nom: "Gmail", methode: "oauth-google" };
export const MICROSOFT = { fournisseur: "microsoft", nom: "Outlook", methode: "oauth-microsoft" };

const CONNUS = [
  { domaines: ["gmail.com", "googlemail.com"], ...GOOGLE },
  { domaines: ["outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr", "msn.com"], ...MICROSOFT },
  {
    domaines: ["icloud.com", "me.com", "mac.com"],
    fournisseur: "icloud",
    nom: "iCloud",
    methode: "mot-de-passe-application",
    guide: "https://support.apple.com/fr-fr/102654",
    imap: imap("imap.mail.me.com"),
    smtp: smtp("smtp.mail.me.com"),
  },
  {
    domaines: ["yahoo.com", "yahoo.fr", "ymail.com"],
    fournisseur: "yahoo",
    nom: "Yahoo",
    methode: "mot-de-passe-application",
    guide: "https://help.yahoo.com/kb/SLN15241.html",
    imap: imap("imap.mail.yahoo.com"),
    smtp: smtp("smtp.mail.yahoo.com"),
  },
  { domaines: ["ik.me", "ikmail.com", "cabinet.com"], fournisseur: "infomaniak", nom: "Infomaniak", methode: "mot-de-passe", imap: imap("mail.infomaniak.com"), smtp: smtp("mail.infomaniak.com") },
  { domaines: ["gmx.fr", "gmx.de", "gmx.net", "gmx.com"], fournisseur: "gmx", nom: "GMX", methode: "mot-de-passe", imap: imap("imap.gmx.net"), smtp: smtp("mail.gmx.net") },
  { domaines: ["orange.fr", "wanadoo.fr"], fournisseur: "orange", nom: "Orange", methode: "mot-de-passe", imap: imap("imap.orange.fr"), smtp: smtp("smtp.orange.fr", 465, "ssl") },
  { domaines: ["free.fr"], fournisseur: "free", nom: "Free", methode: "mot-de-passe", imap: imap("imap.free.fr"), smtp: smtp("smtp.free.fr") },
  { domaines: ["laposte.net"], fournisseur: "laposte", nom: "La Poste", methode: "mot-de-passe", imap: imap("imap.laposte.net"), smtp: smtp("smtp.laposte.net") },
  { domaines: ["proton.me", "protonmail.com", "pm.me"], fournisseur: "proton", nom: "Proton", methode: "non-pris-en-charge" },
];

const PAR_MX = [
  { motif: /(^|\.)google(mail)?\.com\.?$|aspmx\.l\.google\.com/i, ...GOOGLE, nom: "Google Workspace" },
  { motif: /\.mail\.protection\.outlook\.com\.?$|outlook\.com\.?$/i, ...MICROSOFT, nom: "Microsoft 365" },
  { motif: /infomaniak\.ch\.?$/i, fournisseur: "infomaniak", nom: "Infomaniak", methode: "mot-de-passe", imap: imap("mail.infomaniak.com"), smtp: smtp("mail.infomaniak.com") },
  { motif: /\.mail\.ovh\.net\.?$|ovh\.net\.?$/i, fournisseur: "ovh", nom: "OVHcloud", methode: "mot-de-passe", imap: imap("ssl0.ovh.net"), smtp: smtp("ssl0.ovh.net") },
  { motif: /gandi\.net\.?$/i, fournisseur: "gandi", nom: "Gandi", methode: "mot-de-passe", imap: imap("mail.gandi.net"), smtp: smtp("mail.gandi.net") },
  { motif: /ionos\.|1and1\./i, fournisseur: "ionos", nom: "IONOS", methode: "mot-de-passe", imap: imap("imap.ionos.fr"), smtp: smtp("smtp.ionos.fr") },
  { motif: /zoho\.(com|eu)\.?$/i, fournisseur: "zoho", nom: "Zoho", methode: "mot-de-passe", imap: imap("imap.zoho.eu"), smtp: smtp("smtp.zoho.eu") },
  { motif: /icloud\.com\.?$/i, ...CONNUS[2], nom: "iCloud (domaine personnalise)" },
  { motif: /messagingengine\.com\.?$/i, fournisseur: "fastmail", nom: "Fastmail", methode: "mot-de-passe-application", imap: imap("imap.fastmail.com"), smtp: smtp("smtp.fastmail.com") },
];

function securite(type) {
  const t = String(type || "").toUpperCase();
  if (t === "SSL" || t === "TLS") return "ssl";
  if (t === "STARTTLS") return "starttls";
  return "none";
}

/** Lit un fichier autoconfig (format Thunderbird) : premier IMAP et premier SMTP. */
export function lireAutoconfig(xml) {
  const bloc = (balise, type) => {
    const re = new RegExp(`<${balise}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${balise}>`, "i");
    const m = String(xml).match(re);
    if (!m) return null;
    const champ = (n) => (m[1].match(new RegExp(`<${n}>\\s*([^<]+?)\\s*</${n}>`, "i")) || [])[1] || "";
    return { host: champ("hostname"), port: Number(champ("port")) || 0, security: securite(champ("socketType")) };
  };
  const i = bloc("incomingServer", "imap");
  const s = bloc("outgoingServer", "smtp");
  if (!i?.host || !s?.host) return null;
  if (s.security === "ssl" && s.port === 465) Object.assign(s, { port: 587, security: "starttls" });
  const nom = (String(xml).match(/<displayShortName>\s*([^<]+?)\s*<\/displayShortName>/i) || [])[1] || "";
  return { imap: i, smtp: s, nom };
}

async function lireUrl(fetcher, url) {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(6000), redirect: "follow" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/**
 * @param {string} email
 * @param {{ fetch?: typeof fetch, resoudreMx?: (d:string)=>Promise<{exchange:string}[]>, resoudreSrv?: (n:string)=>Promise<{name:string,port:number}[]> }} deps
 */
export async function detecter(email, deps = {}) {
  const adresse = String(email || "").trim().toLowerCase();
  const domaine = adresse.split("@")[1] || "";
  if (!domaine || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domaine)) throw new Error("Adresse e-mail invalide.");
  const fetcher = deps.fetch || fetch;
  const mx = deps.resoudreMx || ((d) => dns.resolveMx(d));
  const srv = deps.resoudreSrv || ((n) => dns.resolveSrv(n));
  const avecAdresse = (r, source) => ({ ...r, domaines: undefined, motif: undefined, source, identifiant: adresse });

  const connu = CONNUS.find((c) => c.domaines.includes(domaine));
  if (connu) return avecAdresse(connu, "connu");

  for (const url of [
    `https://autoconfig.thunderbird.net/v1.1/${domaine}`,
    `https://autoconfig.${domaine}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(adresse)}`,
    `https://${domaine}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(adresse)}`,
  ]) {
    const xml = await lireUrl(fetcher, url);
    const a = xml && lireAutoconfig(xml);
    if (a) {
      if (/\.google(mail)?\.com$/i.test(a.imap.host)) return avecAdresse({ ...GOOGLE, nom: "Google Workspace" }, "autoconfig");
      if (/office365\.com$|outlook\.com$/i.test(a.imap.host)) return avecAdresse({ ...MICROSOFT, nom: "Microsoft 365" }, "autoconfig");
      return avecAdresse({ fournisseur: "autre", nom: a.nom || domaine, methode: "mot-de-passe", imap: a.imap, smtp: a.smtp }, url.includes("thunderbird") ? "ispdb" : "autoconfig");
    }
  }

  try {
    const [i] = await srv(`_imaps._tcp.${domaine}`);
    const [s] = await srv(`_submission._tcp.${domaine}`);
    if (i?.name && i.name !== "." && s?.name && s.name !== ".") {
      return avecAdresse(
        { fournisseur: "autre", nom: domaine, methode: "mot-de-passe", imap: imap(i.name, i.port || 993), smtp: smtp(s.name, s.port || 587) },
        "srv"
      );
    }
  } catch {
    /* pas de SRV */
  }

  try {
    const liste = (await mx(domaine)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const { exchange } of liste) {
      const p = PAR_MX.find((x) => x.motif.test(exchange));
      if (p) return avecAdresse(p, "mx");
    }
  } catch {
    /* pas de MX */
  }

  return avecAdresse(
    { fournisseur: "autre", nom: domaine, methode: "mot-de-passe", imap: imap(`imap.${domaine}`), smtp: smtp(`smtp.${domaine}`), devine: true },
    "devine"
  );
}
