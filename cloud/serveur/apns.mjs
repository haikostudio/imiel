// Notifications iPhone (APNs) envoyees par le pont a chaque nouveau mail :
// expediteur en titre, sujet en texte. Rien n'est garde : la notification
// part, puis le serveur oublie.
//
// Configuration (variables d'environnement ou options.apns) :
//   NUAGE_APNS_CLE (chemin du fichier .p8), NUAGE_APNS_ID_CLE, NUAGE_APNS_EQUIPE,
//   NUAGE_APNS_SUJET (identifiant de l'app iPhone), NUAGE_APNS_PROD=1 (sinon bac a sable).
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";

function config(opt) {
  return {
    cle: opt?.cle ?? process.env.NUAGE_APNS_CLE ?? "",
    idCle: opt?.idCle ?? process.env.NUAGE_APNS_ID_CLE ?? "",
    equipe: opt?.equipe ?? process.env.NUAGE_APNS_EQUIPE ?? "",
    sujet: opt?.sujet ?? process.env.NUAGE_APNS_SUJET ?? "",
    prod: opt?.prod ?? process.env.NUAGE_APNS_PROD === "1",
    envoyer: opt?.envoyer, // essais : remplace l'appel a Apple
  };
}

export function apnsConfigure(opt) {
  const c = config(opt);
  return !!(c.envoyer || (c.cle && c.idCle && c.equipe && c.sujet));
}

let jwtCache = { jeton: "", fin: 0 };
function jwt(c) {
  if (jwtCache.jeton && jwtCache.fin > Date.now()) return jwtCache.jeton;
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const entete = b64u({ alg: "ES256", kid: c.idCle });
  const charge = b64u({ iss: c.equipe, iat: Math.floor(Date.now() / 1000) });
  const signature = crypto
    .sign("sha256", Buffer.from(`${entete}.${charge}`), { key: fs.readFileSync(c.cle, "utf8"), dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  jwtCache = { jeton: `${entete}.${charge}.${signature}`, fin: Date.now() + 40 * 60_000 };
  return jwtCache.jeton;
}

/** Corps APNs : expediteur + sujet, regroupes par boite. */
export function corpsApns({ titre, texte, regroupement, donnees }) {
  const court = (t, n) => (String(t || "").length > n ? String(t).slice(0, n - 1) + "…" : String(t || ""));
  return {
    aps: {
      alert: { title: court(titre || "iMiel", 120), body: court(texte || "Nouveau message", 240) },
      sound: "default",
      "thread-id": regroupement || undefined,
    },
    imiel: donnees || {},
  };
}

export async function envoyerApns(opt, jetonAppareil, donnees) {
  const c = config(opt);
  const corps = corpsApns(donnees);
  if (c.envoyer) return c.envoyer(jetonAppareil, corps);
  const hote = c.prod ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  await new Promise((resolve, reject) => {
    const client = http2.connect(hote);
    client.on("error", reject);
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${jetonAppareil}`,
      authorization: `bearer ${jwt(c)}`,
      "apns-topic": c.sujet,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    let statut = 0;
    let reponse = "";
    req.on("response", (h) => (statut = Number(h[":status"])));
    req.on("data", (d) => (reponse += d));
    req.on("end", () => {
      client.close();
      if (statut === 200) resolve();
      else reject(new Error(`APNs ${statut} ${reponse.slice(0, 200)}`));
    });
    req.end(JSON.stringify(corps));
  });
}
