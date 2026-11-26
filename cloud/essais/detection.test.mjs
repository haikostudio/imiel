// Detection automatique des reglages d'une boite (sans reseau : tout est simule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { detecter, lireAutoconfig } from "../serveur/detection.mjs";

const rien = async () => ({ ok: false, status: 404, text: async () => "" });
const sans = async () => {
  throw new Error("ENODATA");
};

const XML = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="exemple.fr">
<displayShortName>Exemple Mail</displayShortName>
<incomingServer type="imap"><hostname>imap.exemple.fr</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
<incomingServer type="pop3"><hostname>pop.exemple.fr</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
<outgoingServer type="smtp"><hostname>smtp.exemple.fr</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
</emailProvider></clientConfig>`;

test("Gmail et Outlook passent par la connexion du fournisseur", async () => {
  assert.equal((await detecter("x@gmail.com", { fetch: rien })).methode, "oauth-google");
  assert.equal((await detecter("x@hotmail.fr", { fetch: rien })).methode, "oauth-microsoft");
});

test("iCloud et Yahoo : mot de passe d'application guide", async () => {
  const i = await detecter("x@icloud.com", { fetch: rien });
  assert.equal(i.methode, "mot-de-passe-application");
  assert.equal(i.imap.host, "imap.mail.me.com");
  assert.ok(i.guide);
  assert.equal((await detecter("x@yahoo.fr", { fetch: rien })).methode, "mot-de-passe-application");
});

test("base ISPDB de Thunderbird : IMAP 993 SSL, envoi ramene a 587 STARTTLS", async () => {
  const f = async (url) => (url.includes("autoconfig.thunderbird.net") ? { ok: true, text: async () => XML } : rien());
  const d = await detecter("moi@exemple.fr", { fetch: f, resoudreSrv: sans, resoudreMx: sans });
  assert.equal(d.source, "ispdb");
  assert.deepEqual(d.imap, { host: "imap.exemple.fr", port: 993, security: "ssl" });
  assert.deepEqual(d.smtp, { host: "smtp.exemple.fr", port: 587, security: "starttls" });
  assert.equal(d.nom, "Exemple Mail");
});

test("autoconfig du domaine quand l'ISPDB ne connait pas", async () => {
  const f = async (url) => (url.startsWith("https://autoconfig.perso.example/") ? { ok: true, text: async () => XML } : rien());
  const d = await detecter("moi@perso.example", { fetch: f, resoudreSrv: sans, resoudreMx: sans });
  assert.equal(d.source, "autoconfig");
});

test("SRV (RFC 6186)", async () => {
  const srv = async (n) => (n.startsWith("_imaps") ? [{ name: "mail.srv.example", port: 993 }] : [{ name: "mail.srv.example", port: 587 }]);
  const d = await detecter("moi@srv.example", { fetch: rien, resoudreSrv: srv, resoudreMx: sans });
  assert.equal(d.source, "srv");
  assert.equal(d.imap.host, "mail.srv.example");
});

test("serveurs MX : Infomaniak, Google Workspace, Microsoft 365", async () => {
  const mx = (h) => async () => [{ exchange: h, priority: 10 }];
  assert.equal((await detecter("hello@marque.example", { fetch: rien, resoudreSrv: sans, resoudreMx: mx("mta-gw.infomaniak.ch") })).imap.host, "mail.infomaniak.com");
  assert.equal((await detecter("a@boite.example", { fetch: rien, resoudreSrv: sans, resoudreMx: mx("aspmx.l.google.com") })).methode, "oauth-google");
  assert.equal(
    (await detecter("a@pro.example", { fetch: rien, resoudreSrv: sans, resoudreMx: mx("pro-example.mail.protection.outlook.com") })).methode,
    "oauth-microsoft"
  );
});

test("repli devine et adresse invalide", async () => {
  const d = await detecter("a@inconnu.example", { fetch: rien, resoudreSrv: sans, resoudreMx: sans });
  assert.equal(d.devine, true);
  assert.equal(d.imap.host, "imap.inconnu.example");
  await assert.rejects(() => detecter("pas-une-adresse"), /invalide/);
});

test("lecture d'un fichier autoconfig incomplet", () => {
  assert.equal(lireAutoconfig("<clientConfig/>"), null);
});
