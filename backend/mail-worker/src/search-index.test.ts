import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Index de recherche du worker contre une petite data.db de test : contenu
// indexe (debut de mot, accents, expediteur, HTML debalise) et synchronisation
// par difference d'identifiants (mail ajoute, supprime, deplace, brouillon).

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-search-"));
let src: Database.Database;
let idx: typeof import("./search-index");
let search: typeof import("./mail-search");

const addr = (name: string, address: string) => JSON.stringify({ name, address });

function insert(m: {
  id: string;
  folder?: string;
  is_draft?: number;
  date: string;
  subject?: string;
  from?: string;
  to?: string;
  text?: string;
  html?: string;
  is_read?: number;
}) {
  src
    .prepare(
      `INSERT INTO messages(id, account, folder, is_draft, date, subject, from_address,
         to_addresses, cc_addresses, bcc_addresses, text_body, html_body, snippet, thread_id, is_read)
       VALUES (?, 'acc1', ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, '', ?, ?)`
    )
    .run(
      m.id,
      m.folder ?? "f_inbox",
      m.is_draft ?? 0,
      m.date,
      m.subject ?? "",
      m.from ?? addr("", "x@example.com"),
      m.to ?? "[]",
      m.text ?? "",
      m.html ?? "",
      "t_" + m.id,
      m.is_read ?? 1
    );
}

const ids = (keys: { id: string }[] | null) => (keys || []).map((k) => k.id);
const find = (q: string) =>
  ids(idx.searchDocs({ userId: "u1", match: q, orderBy: "date" }));

beforeAll(async () => {
  src = new Database(path.join(dir, "data.db"));
  src.pragma("journal_mode = WAL");
  src.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, blocked_senders TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, user TEXT);
    CREATE TABLE folders (id TEXT PRIMARY KEY, account TEXT, type TEXT);
    CREATE TABLE labels (id TEXT PRIMARY KEY, user TEXT, is_secondary BOOLEAN);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, account TEXT, folder TEXT, is_draft BOOLEAN DEFAULT 0,
      date TEXT, subject TEXT, from_address TEXT, to_addresses TEXT, cc_addresses TEXT,
      bcc_addresses TEXT, text_body TEXT, html_body TEXT, snippet TEXT, thread_id TEXT,
      message_id TEXT DEFAULT '', in_reply_to TEXT DEFAULT '', "references" TEXT,
      is_read BOOLEAN DEFAULT 0, is_starred BOOLEAN DEFAULT 0, is_answered BOOLEAN DEFAULT 0,
      is_sent BOOLEAN DEFAULT 0, has_attachments BOOLEAN DEFAULT 0, priority TEXT DEFAULT 'normal',
      uid NUMERIC DEFAULT 0, labels TEXT DEFAULT '[]', spam_score NUMERIC DEFAULT 0,
      spam_action TEXT DEFAULT '', scheduled_at TEXT DEFAULT ''
    );
    INSERT INTO users VALUES ('u1', '["bloque@spam.test"]'), ('u2', '[]');
    INSERT INTO accounts VALUES ('acc1', 'u1'), ('acc2', 'u2');
    INSERT INTO folders VALUES ('f_inbox', 'acc1', 'inbox'), ('f_sent', 'acc1', 'sent'),
      ('f_trash', 'acc1', 'trash'), ('f_drafts', 'acc1', 'drafts');
  `);
  insert({
    id: "m1",
    date: "2026-01-03 10:00:00.000Z",
    subject: "Résultats d'analyses",
    from: addr("ORBALIE Labosud", "noreply@orbalie.example"),
    text: "Vos résultats sont disponibles.",
  });
  insert({
    id: "m2",
    date: "2026-01-02 10:00:00.000Z",
    subject: "Promo",
    html: '<html><head><style>td{width:600px}</style></head><body><table width="600"><tr><td style="font-size:12px">Bonjour, profitez de la <b>r&eacute;union</b> annuelle</td></tr></table></body></html>',
  });
  insert({
    id: "m3",
    folder: "f_sent",
    date: "2026-01-01 10:00:00.000Z",
    subject: "Tiers payant",
    to: JSON.stringify([{ name: "Accueil", address: "contact@labo.orbalie.example" }]),
    text: "Bonjour, voici le document demandé pour le projet.",
  });
  insert({
    id: "m4",
    date: "2025-12-31 10:00:00.000Z",
    subject: "Marko Vujasorbalic",
    text: "rien a voir",
  });
  insert({
    id: "m5",
    date: "2025-12-30 10:00:00.000Z",
    subject: "Offre orbalie",
    from: addr("Pub", "bloque@spam.test"),
    is_read: 0,
  });
  src.exec(`INSERT INTO accounts VALUES ('acc9', 'u2')`);
  src
    .prepare(
      `INSERT INTO messages(id, account, folder, date, subject, from_address, to_addresses, text_body, html_body, snippet)
       VALUES ('other', 'acc9', 'f_x', '2026-01-01 00:00:00.000Z', 'orbalie prive', '{}', '[]', '', '', '')`
    )
    .run();

  process.env.PB_DATA_PATH = dir;
  process.env.SEARCH_INDEX_PATH = path.join(dir, "search.db");
  vi.resetModules();
  idx = await import("./search-index");
  search = await import("./mail-search");
  await idx.syncSearchIndex();
});

afterAll(() => {
  src.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("contenu indexe", () => {
  it("un debut de mot suffit, sans tenir compte de la casse", () => {
    expect(find('"orbali"*')).toEqual(["m1", "m3", "m5"]);
    expect(find('"ORBALIE"*')).toEqual(["m1", "m3", "m5"]);
  });

  it("ne trouve pas un morceau au milieu d'un mot", () => {
    expect(find('"orbali"*')).not.toContain("m4");
  });

  it("indexe l'expediteur et les destinataires, adresse comprise", () => {
    expect(find('sender : "orbalie"*')).toEqual(["m1"]);
    expect(find('"noreply@orbalie.example"*')).toEqual(["m1"]);
    expect(find('recipients : "contact@labo.orbalie.example"*')).toEqual(["m3"]);
  });

  it("ignore le balisage HTML mais garde le texte du mail", () => {
    expect(find('"width"*')).toEqual([]);
    expect(find('"font"*')).toEqual([]);
    expect(find('"profitez"*')).toEqual(["m2"]);
  });

  it("ignore les accents des deux cotes", () => {
    expect(find('"reunion"*')).toEqual(["m2"]);
    expect(find('"résultats"*')).toEqual(["m1"]);
  });

  it("ne rend jamais les mails d'un autre utilisateur", () => {
    expect(find('"prive"*')).toEqual([]);
    expect(ids(idx.searchDocs({ userId: "u2", match: '"prive"*' }))).toEqual(["other"]);
  });
});

describe("htmlToIndexText", () => {
  it("retire styles, scripts et balises, decode les entites", () => {
    expect(
      idx.htmlToIndexText(
        '<head><title>x</title><style>.a{font:1px}</style></head><!-- width --><p style="width:1px">D&eacute;j&agrave; l&#39;&#233;t&#xE9;&nbsp;!</p><script>var table;</script>'
      )
    ).toBe("Déjà l'été !");
  });
});

describe("synchronisation par difference d'identifiants", () => {
  it("prend un nouveau mail, retire un mail supprime, suit un deplacement", async () => {
    insert({ id: "m6", date: "2026-02-01 10:00:00.000Z", subject: "Devis Orbalie Montpellier" });
    src.prepare(`DELETE FROM messages WHERE id = 'm3'`).run();
    src.prepare(`UPDATE messages SET folder = 'f_trash' WHERE id = 'm1'`).run();
    await idx.syncSearchIndex();
    const keys = idx.searchDocs({ userId: "u1", match: '"orbali"*', orderBy: "date" }) || [];
    expect(keys.map((k) => k.id)).toEqual(["m6", "m1", "m5"]);
    expect(keys.find((k) => k.id === "m1")?.folder).toBe("f_trash");
  });

  it("relit un brouillon dont le texte a change", async () => {
    insert({
      id: "d1",
      folder: "f_drafts",
      is_draft: 1,
      date: "2026-02-02 10:00:00.000Z",
      subject: "Brouillon",
      text: "premiere version",
    });
    await idx.syncSearchIndex();
    expect(find('"premiere"*')).toEqual(["d1"]);
    src.prepare(`UPDATE messages SET text_body = 'seconde mouture' WHERE id = 'd1'`).run();
    await idx.syncSearchIndex();
    expect(find('"premiere"*')).toEqual([]);
    expect(find('"mouture"*')).toEqual(["d1"]);
  });

  it("une passe sans changement ne modifie rien", async () => {
    const before = idx.getSearchIndexState().done;
    await idx.syncSearchIndex();
    await idx.syncSearchIndex(true);
    expect(idx.getSearchIndexState().done).toBe(before);
  });
});

describe("runMailSearch", () => {
  it("palette et liste d'un dossier rendent les memes resultats", async () => {
    const palette = await search.runMailSearch({ userId: "u1", query: "orbali", perPage: 200 });
    expect(palette?.counts).toEqual({ inbox: 1, trash: 1 });
    const inbox = await search.runMailSearch({
      userId: "u1",
      query: "orbali",
      scope: { folderIds: ["f_inbox"], isDraft: false },
    });
    expect(inbox?.totalItems).toBe(palette?.counts.inbox);
    expect(inbox?.items.map((i) => i.id)).toEqual(["m6"]);
    expect(inbox?.items[0].folder_type).toBe("inbox");
  });

  it("n'affiche jamais un expediteur bloque", async () => {
    const r = await search.runMailSearch({ userId: "u1", query: "offre", perPage: 50 });
    expect(r?.totalItems).toBe(0);
  });

  it("pagine sans plafond et annonce le total exact", async () => {
    const p1 = await search.runMailSearch({ userId: "u1", query: "orbali", perPage: 1, page: 1 });
    const p2 = await search.runMailSearch({ userId: "u1", query: "orbali", perPage: 1, page: 2 });
    expect(p1?.totalItems).toBe(2);
    expect(p1?.totalPages).toBe(2);
    expect(p1?.items[0].id).toBe("m6");
    expect(p2?.items[0].id).toBe("m1");
  });

  it("applique les operateurs et les caracteres speciaux sans erreur", async () => {
    const from = await search.runMailSearch({ userId: "u1", query: "from:orbalie" });
    expect(from?.items.map((i) => i.id)).toEqual(["m1"]);
    for (const q of ['in"ovi', "orbali*", "-orbali", "(orbali", "orbali:", "AND", "NEAR(", "^orbali"]) {
      const r = await search.runMailSearch({ userId: "u1", query: q });
      expect(r, q).not.toBeNull();
    }
  });
});
