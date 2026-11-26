// « Se connecter avec Google / Microsoft » : la boite se relie d'un clic, sans
// mot de passe d'application. Le jeton de renouvellement est garde dans les
// reglages chiffres du compte ; le jeton d'acces (1 h) est renouvele a la
// demande et ne vit qu'en memoire.
//
// Google : client OAuth « application Web » du serveur, portees
//   https://mail.google.com/ (lecture et envoi par IMAP/SMTP), agenda, profil.
//   Portee RESTREINTE : tant que Google n'a pas valide l'application
//   (verification + evaluation de securite annuelle), elle reste en mode Test,
//   limitee a 100 utilisateurs declares, avec un ecran d'avertissement.
// Microsoft : application inscrite pour comptes professionnels ET personnels,
//   portees IMAP.AccessAsUser.All, SMTP.Send, offline_access.
//
// Variables : NUAGE_ADRESSE_PUBLIQUE (https://sync.example.com),
//   NUAGE_GOOGLE_ID, NUAGE_GOOGLE_SECRET, NUAGE_MICROSOFT_ID, NUAGE_MICROSOFT_SECRET.
import crypto from "node:crypto";

export const FOURNISSEURS = {
  google: {
    autorisation: "https://accounts.google.com/o/oauth2/v2/auth",
    jeton: "https://oauth2.googleapis.com/token",
    portees: [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/calendar",
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    imap: { host: "imap.gmail.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.gmail.com", port: 587, security: "starttls" },
    nom: "Gmail",
  },
  microsoft: {
    autorisation: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    jeton: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    portees: [
      "offline_access",
      "openid",
      "email",
      "profile",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
    ],
    extra: { prompt: "select_account" },
    imap: { host: "outlook.office365.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
    nom: "Outlook",
  },
};

export function configOauth(env = process.env) {
  return {
    adresse: (env.NUAGE_ADRESSE_PUBLIQUE || "").replace(/\/+$/, ""),
    google: { id: env.NUAGE_GOOGLE_ID || "", secret: env.NUAGE_GOOGLE_SECRET || "" },
    microsoft: { id: env.NUAGE_MICROSOFT_ID || "", secret: env.NUAGE_MICROSOFT_SECRET || "" },
  };
}

export const oauthPret = (cfg, f) => !!(cfg.adresse && cfg[f]?.id && cfg[f]?.secret);
const retour = (cfg, f) => `${cfg.adresse}/v1/oauth/${f}/retour`;

/** Etat signe (HMAC) : relie le retour du fournisseur au compte qui l'a demande. */
export function signerEtat(secret, donnees) {
  const corps = Buffer.from(JSON.stringify({ ...donnees, exp: Date.now() + 15 * 60_000, n: crypto.randomBytes(6).toString("hex") })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(corps).digest("base64url");
  return `${corps}.${sig}`;
}

export function lireEtat(secret, etat) {
  const [corps, sig] = String(etat || "").split(".");
  if (!corps || !sig) return null;
  const attendu = crypto.createHmac("sha256", secret).update(corps).digest("base64url");
  if (sig.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
  const d = JSON.parse(Buffer.from(corps, "base64url").toString("utf8"));
  return d.exp > Date.now() ? d : null;
}

export function adresseAutorisation(cfg, f, etat, indice = "") {
  const p = FOURNISSEURS[f];
  const q = new URLSearchParams({
    client_id: cfg[f].id,
    redirect_uri: retour(cfg, f),
    response_type: "code",
    scope: p.portees.join(" "),
    state: etat,
    ...p.extra,
    ...(indice ? { login_hint: indice } : {}),
  });
  return `${p.autorisation}?${q}`;
}

async function appelJeton(cfg, f, corps, fetcher = fetch) {
  const p = FOURNISSEURS[f];
  const r = await fetcher(p.jeton, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg[f].id, client_secret: cfg[f].secret, ...corps }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || `refus ${r.status}`);
    e.invalide = j.error === "invalid_grant";
    throw e;
  }
  return j;
}

function adresseDuJeton(idToken) {
  try {
    const charge = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
    return { email: charge.email || charge.preferred_username || "", nom: charge.name || "" };
  } catch {
    return { email: "", nom: "" };
  }
}

/** Echange le code du retour contre les jetons, et construit la boite. */
export async function finirConnexion(cfg, f, code, fetcher) {
  const j = await appelJeton(cfg, f, { code, grant_type: "authorization_code", redirect_uri: retour(cfg, f) }, fetcher);
  const { email, nom } = adresseDuJeton(j.id_token);
  if (!email) throw new Error("Le fournisseur n'a pas donne l'adresse de la boite.");
  if (!j.refresh_token) throw new Error("Le fournisseur n'a pas accorde l'acces durable : recommencez.");
  const p = FOURNISSEURS[f];
  return {
    email: email.toLowerCase(),
    display_name: nom,
    fournisseur: f,
    auth: "oauth2",
    oauth_provider: f,
    oauth: { refresh_token: j.refresh_token, portees: j.scope || p.portees.join(" ") },
    imap: { ...p.imap, username: email.toLowerCase() },
    smtp: { ...p.smtp, username: email.toLowerCase() },
  };
}

/** Jetons d'acces en memoire seulement (cle : identifiant de boite). */
export function gestionnaireJetons(cfg, { fetcher, surRefus } = {}) {
  const cache = new Map();
  return async function jetonAcces(boite) {
    const c = cache.get(boite.id);
    if (c && c.fin > Date.now() + 60_000) return c.jeton;
    const f = boite.oauth_provider;
    if (!oauthPret(cfg, f)) throw new Error("Connexion " + f + " non configuree sur ce serveur.");
    try {
      const j = await appelJeton(cfg, f, { refresh_token: boite.oauth?.refresh_token || "", grant_type: "refresh_token" }, fetcher);
      cache.set(boite.id, { jeton: j.access_token, fin: Date.now() + Number(j.expires_in || 3600) * 1000 });
      return j.access_token;
    } catch (e) {
      if (e.invalide) surRefus?.(boite);
      throw e;
    }
  };
}
