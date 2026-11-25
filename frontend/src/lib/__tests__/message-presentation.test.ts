import { describe, expect, it } from "vitest";
import {
  classifyMessagePresentation,
  extractBubbleText,
  hasRichLayout,
  htmlPillShown,
  htmlToText,
  isAutomatedAddress,
  splitQuoteHeader,
  splitQuotedText,
} from "@/lib/utils/message-presentation";

const person = { name: "Olivier Girard", address: "olivier.girard@atelier-example.ch" };

describe("classifyMessagePresentation", () => {
  it("met en bulle un mail Gmail ecrit par une personne", () => {
    expect(
      classifyMessagePresentation({
        from_address: person,
        text_body: "Bonjour Christophe,\n\nComment allez-vous ?",
        html_body: '<div dir="ltr">Bonjour Christophe,<div><br></div><div>Comment allez-vous ?</div></div>',
        raw_headers: "Received: from mail.example\r\nMIME-Version: 1.0\r\n",
      })
    ).toBe("bubble");
  });

  it("garde en bulle un mail Outlook avec une signature illustree", () => {
    const html =
      '<html><head><style>p.MsoNormal{margin:0}</style></head><body><p class="MsoNormal">Bonjour,</p><p class="MsoNormal">Je vous confirme le rendez-vous de jeudi.</p>' +
      '<table><tr><td><img src="cid:logo.png" width="120"></td><td>Eva Morel<br>Association Asso</td></tr></table></body></html>';
    expect(
      classifyMessagePresentation({
        from_address: { name: "Eva Morel", address: "eva.morel@association-example.org" },
        html_body: html,
        text_body: "",
      })
    ).toBe("bubble");
  });

  it("affiche en entier une newsletter avec desinscription de liste", () => {
    expect(
      classifyMessagePresentation({
        from_address: { name: "AI Secret", address: "hello@ia-newsletter.example.com" },
        text_body: "96 Founders Who Only Date Sequoia",
        html_body: "<p>96 Founders</p>",
        raw_headers: "List-Unsubscribe: <mailto:unsub@ia-newsletter.example.com>\r\nPrecedence: bulk\r\n",
      })
    ).toBe("full");
  });

  it("affiche en entier une confirmation de reservation mise en page", () => {
    const html =
      '<table width="600" align="center"><tr><td><img src="https://cdn.thefork.com/logo.png"></td></tr>' +
      "<tr><td><table><tr><td>Le Bombay</td><td>15 octobre 2026</td></tr></table></td></tr>" +
      '<tr><td><table><tr><td><img src="https://cdn.thefork.com/map.png"></td></tr></table></td></tr></table>';
    expect(
      classifyMessagePresentation({
        from_address: { name: "TheFork", address: "reservations@thefork.com" },
        html_body: html,
        text_body: "Votre reservation est confirmee",
      })
    ).toBe("full");
  });

  it("affiche en entier un mail d'une adresse no-reply", () => {
    expect(
      classifyMessagePresentation({
        from_address: { name: "Google", address: "no-reply@accounts.google.com" },
        text_body: "Vous avez autorise une nouvelle connexion.",
      })
    ).toBe("full");
  });

  it("affiche en entier un expediteur suivi comme newsletter", () => {
    expect(
      classifyMessagePresentation(
        { from_address: person, text_body: "Edito de la semaine" },
        { isNewsletterSource: true }
      )
    ).toBe("full");
  });

  it("met toujours en bulle un mail de l'utilisateur", () => {
    expect(
      classifyMessagePresentation(
        { from_address: { address: "christophe@studio.example.com" }, text_body: "Merci !" },
        { isMine: true }
      )
    ).toBe("bubble");
  });

  it("affiche en entier un mail sans texte lisible", () => {
    expect(
      classifyMessagePresentation({ from_address: person, html_body: '<img src="https://x/flyer.png">', text_body: "" })
    ).toBe("full");
  });
});

describe("isAutomatedAddress / hasRichLayout", () => {
  it("reconnait les adresses automatiques", () => {
    expect(isAutomatedAddress("noreply@credit-agricole.fr")).toBe(true);
    expect(isAutomatedAddress("do-not-reply@apple.com")).toBe(true);
    expect(isAutomatedAddress("notifications@github.com")).toBe(true);
    expect(isAutomatedAddress("olivier@atelier-example.ch")).toBe(false);
    expect(isAutomatedAddress("support@apple.com")).toBe(false);
  });

  it("ignore les pixels de suivi dans le compte des images", () => {
    expect(hasRichLayout('<p>Salut</p><img src="a" width="1" height="1"><img src="b" width="1"><img src="c" height="0">')).toBe(false);
    expect(hasRichLayout('<img src="a"><img src="b"><img src="c">')).toBe(true);
  });
});

describe("splitQuotedText", () => {
  it("separe la reponse de l'historique Gmail", () => {
    const text =
      "Bonjour Olivier,\n\nBien sur, avec plaisir.\n\nChris.\n\nLe jeu. 15 oct. 2026 a 10:25, Olivier Girard <olivier@atelier-example.ch> a ecrit :\n> Bonjour Christophe,\n> Comment allez-vous ?";
    const r = splitQuotedText(text);
    expect(r.body).toBe("Bonjour Olivier,\n\nBien sur, avec plaisir.\n\nChris.");
    expect(r.quoted).toMatch(/^Le jeu\. 15 oct\./);
  });

  it("reconnait une attribution coupee sur deux lignes", () => {
    const text = "Parfait, merci.\n\nLe jeu. 15 oct. 2026 a 10:25, Olivier Girard <o@x.ch> a\necrit :\n> Bonjour";
    const r = splitQuotedText(text);
    expect(r.body).toBe("Parfait, merci.");
    expect(r.quoted).not.toBeNull();
  });

  it("reconnait le bloc Outlook De / Envoye", () => {
    const text = "Ok pour moi.\n\n________________________________\nDe : Eva Morel\nEnvoye : jeudi 15 octobre 2026 10:25\nA : Christophe\nObjet : RDV";
    const r = splitQuotedText(text);
    expect(r.body).toBe("Ok pour moi.");
    expect(r.quoted).toMatch(/^_{8,}/);
  });

  it("reconnait l'attribution anglaise", () => {
    const r = splitQuotedText("Sounds good.\n\nOn Thu, Oct 15, 2026 at 10:25 AM Olivier <o@x.ch> wrote:\n> Hi");
    expect(r.body).toBe("Sounds good.");
  });

  it("ne mange jamais un mail qui n'est que citation", () => {
    const text = "Le jeu. 15 oct. 2026 a 10:25, Olivier <o@x.ch> a ecrit :\n> Bonjour\n> Ceci est tout le contenu";
    const r = splitQuotedText(text);
    expect(r.body).toContain("Ceci est tout le contenu");
    expect(r.quoted).toBeNull();
  });

  it("laisse intact un mail sans historique", () => {
    expect(splitQuotedText("Bonjour,\nA demain.")).toEqual({ body: "Bonjour,\nA demain.", quoted: null });
  });
});

describe("extractBubbleText / htmlToText / splitQuoteHeader", () => {
  it("tire le texte d'un mail HTML sans texte brut", () => {
    const r = extractBubbleText({
      html_body: "<div>Bonjour&nbsp;Olivier,</div><div><br></div><div>Merci &amp; a bientot.</div>",
      text_body: "",
    });
    expect(r.body).toBe("Bonjour Olivier,\n\nMerci & a bientot.");
  });

  it("retire styles et commentaires", () => {
    expect(htmlToText("<style>p{color:red}</style><!-- x --><p>Salut</p>")).toBe("Salut");
  });

  it("isole la ligne d'attribution de l'historique", () => {
    const { header, rest } = splitQuoteHeader("Le 15 octobre 2026 a 10:25, Olivier a ecrit :\n> Bonjour\n> Comment allez-vous ?");
    expect(header).toBe("Le 15 octobre 2026 a 10:25, Olivier a ecrit :");
    expect(rest).toBe("Bonjour\nComment allez-vous ?");
  });
});

describe("htmlPillShown", () => {
  it("montre la pastille HTML sous un mail mis en page qui a un HTML", () => {
    expect(htmlPillShown("full", { html_body: "<table><tr><td>Facture</td></tr></table>" })).toBe(true);
  });

  it("pas de pastille pour un echange ecrit par une personne", () => {
    expect(htmlPillShown("bubble", { html_body: "<p>Bonjour</p>" })).toBe(false);
  });

  it("pas de pastille sans HTML (rien a ouvrir)", () => {
    expect(htmlPillShown("full", { html_body: "" })).toBe(false);
    expect(htmlPillShown("full", {})).toBe(false);
  });

  it("un mail Apple Support (no-reply, mise en page) porte la pastille", () => {
    const message = {
      from_address: { name: "Apple Support", address: "noreply@email.apple.com" },
      html_body: "<table width=\"600\" align=\"center\"><tr><td><p>Votre demande</p></td></tr></table>",
    };
    expect(htmlPillShown(classifyMessagePresentation(message), message)).toBe(true);
  });
});
