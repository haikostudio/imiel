import { describe, expect, it } from "vitest";
import {
  classifyLink,
  displayHost,
  filenameFromContentDisposition,
  previewKindFor,
  safariSchemeUrl,
  type ClassifyOptions,
} from "@/lib/link-open";

const base: ClassifyOptions = {
  origin: "https://imiel.example.com",
  pageHref: "https://imiel.example.com/#/mail/inbox?t=abc",
  standalone: true,
  desktop: false,
};

describe("classifyLink", () => {
  it("app installee : autre site http(s) -> navigateur systeme", () => {
    expect(classifyLink("https://fr.wikipedia.org/wiki/Baleine", base)).toBe("external");
    expect(classifyLink("http://exemple.com/a", { ...base, target: "_blank" })).toBe("external");
  });

  it("app installee : fichiers de l'app -> tiroir fichier", () => {
    expect(classifyLink("/api/files/attachments/x/doc.pdf", base)).toBe("file");
    expect(classifyLink("https://imiel.example.com/api/files/c/r/img.png?download=1", base)).toBe("file");
    expect(classifyLink("/autre", { ...base, download: true })).toBe("file");
    expect(classifyLink("/autre", { ...base, target: "_blank" })).toBe("file");
  });

  it("fichiers servis par une PocketBase d'une autre origine -> tiroir fichier", () => {
    const opts = { ...base, fileOrigins: ["https://pb.exemple.com"] };
    expect(classifyLink("https://pb.exemple.com/api/files/a/b/c.pdf", opts)).toBe("file");
  });

  it("jamais retenus : mailto, tel, blob, data, fragment seul, navigation interne", () => {
    for (const href of [
      "mailto:a@b.c",
      "tel:+41000",
      "blob:https://imiel.example.com/123",
      "data:text/plain,abc",
      "javascript:void(0)",
      "#/suivi",
      "#",
      "",
      "/#/contacts",
      "https://imiel.example.com/#/mail/sent",
    ]) {
      expect(classifyLink(href, base), href).toBe("ignore");
    }
    // Lien interne sans target ni download : navigation normale.
    expect(classifyLink("/settings", base)).toBe("ignore");
  });

  it("onglet classique et app de bureau : rien ne change", () => {
    expect(classifyLink("https://fr.wikipedia.org", { ...base, standalone: false })).toBe("ignore");
    expect(classifyLink("/api/files/a/b/c.pdf", { ...base, standalone: false })).toBe("ignore");
    expect(classifyLink("https://fr.wikipedia.org", { ...base, desktop: true })).toBe("ignore");
  });
});

describe("filenameFromContentDisposition", () => {
  it("lit filename* (UTF-8) en priorite puis filename", () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''facture%20%C3%A9t%C3%A9.pdf")).toBe("facture été.pdf");
    expect(filenameFromContentDisposition('inline; filename="photo.png"')).toBe("photo.png");
    expect(filenameFromContentDisposition("attachment; filename=plan.pdf")).toBe("plan.pdf");
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition("inline")).toBeNull();
  });
});

describe("helpers", () => {
  it("displayHost retire www.", () => {
    expect(displayHost("https://www.colissimo.fr/suivi")).toBe("colissimo.fr");
  });
  it("previewKindFor", () => {
    expect(previewKindFor("image/jpeg")).toBe("image");
    expect(previewKindFor("application/pdf")).toBe("pdf");
    expect(previewKindFor("video/mp4")).toBe("video");
    expect(previewKindFor("application/zip")).toBe("other");
  });
});

describe("safariSchemeUrl", () => {
  it("prefixe le schema Safari et garde le reste de l'adresse", () => {
    expect(safariSchemeUrl("https://immo-newsletter.example.com/news?id=1#a")).toBe(
      "x-safari-https://immo-newsletter.example.com/news?id=1#a"
    );
    expect(safariSchemeUrl("HTTP://exemple.com")).toBe("x-safari-http://exemple.com");
  });
  it("refuse ce qui n'est pas http(s)", () => {
    expect(safariSchemeUrl("mailto:a@b.c")).toBeNull();
    expect(safariSchemeUrl("")).toBeNull();
  });
});
