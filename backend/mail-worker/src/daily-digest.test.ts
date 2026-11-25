import { describe, expect, it } from "vitest";
import {
  dailyDigestWindow,
  fallbackSelect,
  isAwaitingReply,
  parisMidnightIso,
  parseAiSelection,
  plainExcerpt,
  windowForToday,
} from "./daily-digest";
import { buildDailyDigestContent, type DailyDigestData } from "./daily-digest-template";
import { isDigestMessageId, digestMessageId } from "./digest-id";

describe("fenetre du recapitulatif", () => {
  it("part a 7 h Paris et resume la veille", () => {
    // 2026-11-14 07:05 Paris = 06:05 UTC (heure d'hiver)
    const w = dailyDigestWindow(new Date("2026-11-14T06:05:00Z"));
    expect(w?.day).toBe("2026-11-13");
    expect(w?.lo).toBe("2026-11-12T23:00:00.000Z");
    expect(w?.hi).toBe("2026-11-13T23:00:00.000Z");
  });

  it("rien avant 7 h ni apres midi (bilan perime)", () => {
    expect(dailyDigestWindow(new Date("2026-11-14T05:59:00Z"))).toBeNull(); // 6:59 Paris
    expect(dailyDigestWindow(new Date("2026-11-14T10:30:00Z"))).not.toBeNull(); // 11:30 rattrapage
    expect(dailyDigestWindow(new Date("2026-11-14T11:00:00Z"))).toBeNull(); // 12:00 Paris
  });

  it("heure d'ete : 7 h Paris = 5 h UTC", () => {
    expect(dailyDigestWindow(new Date("2026-07-10T04:59:00Z"))).toBeNull();
    const w = dailyDigestWindow(new Date("2026-07-10T05:01:00Z"));
    expect(w?.day).toBe("2026-07-09");
    expect(w?.lo).toBe("2026-07-08T22:00:00.000Z");
  });

  it("jour du changement d'heure : la veille dure 23 h ou 25 h", () => {
    // Passage a l'heure d'ete le dimanche 29 mars 2026.
    expect(parisMidnightIso("2026-03-29")).toBe("2026-03-28T23:00:00.000Z");
    expect(parisMidnightIso("2026-03-30")).toBe("2026-03-29T22:00:00.000Z");
    const w = windowForToday("2026-03-30");
    expect(Date.parse(w.hi) - Date.parse(w.lo)).toBe(23 * 3600_000);
    // Retour a l'heure d'hiver le dimanche 25 octobre 2026.
    const w2 = windowForToday("2026-10-26");
    expect(Date.parse(w2.hi) - Date.parse(w2.lo)).toBe(25 * 3600_000);
  });

  it("le lundi ajoute la semaine ecoulee (sujets qui montent)", () => {
    expect(windowForToday("2026-11-16").week).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(windowForToday("2026-11-17").week).toBeNull();
  });
});

describe("suivis qui attendent une reponse", () => {
  const own = new Set(["moi@exemple.fr"]);
  const hi = "2026-11-13T23:00:00.000Z";
  it("dernier message d'un tiers recent : attend", () => {
    expect(isAwaitingReply({ is_sent: false, from: "Paul@Client.fr", date: "2026-11-12 09:00:00.000Z" }, own, hi)).toBe(true);
  });
  it("dernier message envoye ou de moi : n'attend pas", () => {
    expect(isAwaitingReply({ is_sent: true, from: "moi@exemple.fr", date: "2026-11-12 09:00:00.000Z" }, own, hi)).toBe(false);
    expect(isAwaitingReply({ is_sent: false, from: "moi@exemple.fr", date: "2026-11-12 09:00:00.000Z" }, own, hi)).toBe(false);
  });
  it("expediteur automatique ou fil trop ancien : n'attend pas", () => {
    expect(isAwaitingReply({ is_sent: false, from: "no-reply@colissimo.fr", date: "2026-11-12 09:00:00.000Z" }, own, hi)).toBe(false);
    expect(isAwaitingReply({ is_sent: false, from: "paul@client.fr", date: "2026-10-01 09:00:00.000Z" }, own, hi)).toBe(false);
    expect(isAwaitingReply(null, own, hi)).toBe(false);
  });
});

describe("selection des mails importants", () => {
  it("lit la reponse de l'IA et ignore les numeros invalides", () => {
    const r = parseAiSelection('```json\n{"items":[{"i":2,"kind":"facturation","summary":"Facture 42"},{"i":9,"kind":"client"},{"i":2,"kind":"client"},{"i":1,"kind":"bizarre"}]}\n```', 3);
    expect(r).toEqual([
      { i: 1, kind: "facturation", summary: "Facture 42" },
      { i: 0, kind: "important", summary: "" },
    ]);
    expect(parseAiSelection("pas du json", 3)).toBeNull();
  });

  it("repli sans IA : correspondants de confiance et etiquettes de facturation", () => {
    const msg = (id: string) => ({ id } as never);
    const out = fallbackSelect([
      { msg: msg("a"), labels: [], trusted: true },
      { msg: msg("b"), labels: ["Facture"], trusted: false },
      { msg: msg("c"), labels: ["Promotion"], trusted: false },
    ]);
    expect(out.map((o) => [(o.c.msg as { id: string }).id, o.kind])).toEqual([
      ["a", "important"],
      ["b", "facturation"],
    ]);
  });

  it("extrait en texte brut, coupe proprement", () => {
    expect(plainExcerpt("<p>Bonjour&nbsp;<b>Paul</b></p><p>Suite</p>")).toBe("Bonjour Paul Suite");
    const long = plainExcerpt("mot ".repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("identifiant du mail depose", () => {
  it("reste reconnu par la synchronisation (jamais newsletter ni notifie)", () => {
    expect(isDigestMessageId(digestMessageId("daily-2026-11-13", "u1"))).toBe(true);
  });
});

function sample(over: Partial<DailyDigestData> = {}): DailyDigestData {
  return {
    day: "2026-11-13",
    appUrl: "https://mail.exemple.fr",
    mails: [
      {
        senderName: "Client <script>alert(1)</script>",
        senderAddress: "client@exemple.fr",
        subject: "Devis <script>x</script> " + "tresloooooooooooooooooooooooooooongmotsansespace".repeat(3),
        summary: "Demande un devis & un rendez-vous",
        kind: "client",
        url: "https://mail.exemple.fr/#/mail/all?t=t1&m=m1",
      },
    ],
    moreMails: 2,
    newsletters: [
      { title: "IA cette semaine", source: "Tech Hebdo", summary: "Trois annonces.", alert: "IA", url: "https://mail.exemple.fr/#/newsletters" },
    ],
    newsletterTotal: 4,
    tracking: [
      { title: "Commande - Boutique", status: "Expediee", reason: "moved", detail: "Colis remis au transporteur", url: "https://mail.exemple.fr/#/suivi?f=i1" },
      { title: "Dossier banque", status: "", reason: "awaiting", detail: "Dernier message de x@banque.fr", url: "https://mail.exemple.fr/#/suivi?f=i2" },
    ],
    trends: [{ tag: "GPT", delta: 3, count: 5 }],
    trendsTotal: 12,
    ...over,
  };
}

describe("gabarit du recapitulatif", () => {
  const c = buildDailyDigestContent(sample());

  it("sujet qui annonce le contenu, jamais echappe", () => {
    expect(c.subject).toBe("Votre journée d'hier : 3 mails importants, 2 suivis, 1 nouvelle");
    expect(c.empty).toBe(false);
  });

  it("echappe tout texte venu de l'exterieur", () => {
    expect(c.html).not.toContain("<script>");
    expect(c.html).toContain("&lt;script&gt;");
  });

  it("aucune construction que les messageries cassent", () => {
    const styles = Array.from(c.html.matchAll(/style="([^"]*)"/g)).map((m) => m[1]).join(";");
    expect(c.html).not.toMatch(/<style|@media|<svg/i);
    expect(styles).not.toMatch(/display:\s*(flex|grid)|var\(--/);
    const srcs = Array.from(c.html.matchAll(/<img[^>]*src="([^"]*)"/g)).map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(s).toMatch(/^https:\/\/.*\.png$/);
    expect(Buffer.byteLength(c.html)).toBeLessThan(100_000);
  });

  it("chaque lien du HTML figure dans la version texte", () => {
    const links = Array.from(c.html.matchAll(/href="([^"]*)"/g)).map((m) => m[1].replace(/&amp;/g, "&"));
    expect(links.length).toBeGreaterThan(4);
    for (const l of links) expect(c.text).toContain(l);
  });

  it("jour vide : mail court Rien d'important hier", () => {
    const e = buildDailyDigestContent(sample({ mails: [], moreMails: 0, newsletters: [], newsletterTotal: 0, tracking: [], trends: null }));
    expect(e.empty).toBe(true);
    expect(e.subject).toBe("Rien d'important hier");
    expect(e.html).toContain("Rien d&#39;important hier");
    expect(e.html).toContain("/images/digest/check.png");
  });

  it("le lundi, les sujets qui montent apparaissent en derniere rubrique", () => {
    expect(c.html.indexOf("Sujets qui montent")).toBeGreaterThan(c.html.indexOf("Dans vos newsletters"));
    expect(c.text).toContain("GPT : +3 (5)");
  });
});
