import { describe, it, expect } from "vitest";
import { sanitizeHtml, collectRemoteImageUrls } from "../sanitize";

describe("sanitizeHtml", () => {
  it("garde les balises HTML autorisees", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    const result = sanitizeHtml(html);
    expect(result).toContain("<p>");
    expect(result).toContain("<strong>");
  });

  it("supprime les balises script", () => {
    const html = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
  });

  it("supprime les balises style", () => {
    const html = "<style>body{color:red}</style><p>Hello</p>";
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<style");
  });

  it("supprime les iframes", () => {
    const html = '<iframe src="http://evil.com"></iframe><p>Hello</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<iframe");
  });

  it("supprime les formulaires", () => {
    const html = '<form action="/steal"><input type="password"></form>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<form");
    expect(result).not.toContain("<input");
  });

  it("supprime les event handlers", () => {
    const html = '<img src="x" onerror="alert(1)">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onerror");
  });

  it("bloque les images externes par defaut", () => {
    const html = '<img src="https://tracker.com/pixel.png" alt="test">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("tracker.com");
  });

  it("autorise les images data: URI", () => {
    const html = '<img src="data:image/png;base64,abc123" alt="ok">';
    const result = sanitizeHtml(html);
    expect(result).toContain("data:image/png;base64,abc123");
  });

  it("retire les images a adresse relative (introuvables : plus d'icone cassee)", () => {
    const html = '<p>Texte</p><img src="/illustration-panne.png?v=2" alt="panne"><img src="logo.png">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<img");
    expect(result).toContain("Texte");
  });

  it("garde les fichiers PocketBase de confiance (signatures, pieces jointes)", () => {
    const html = '<img src="/api/files/accounts/abc/sig.png">';
    const result = sanitizeHtml(html, { trustedImageSrc: (s) => s.startsWith("/api/files/") });
    expect(result).toContain("/api/files/accounts/abc/sig.png");
  });

  it("reecrit les images distantes vers le proxy signe", () => {
    const html = '<img src="https://cdn.example.com/a.png" width="600"><img src="//cdn.example.com/b.jpg">';
    const proxy = (u: string) => `/worker/image-proxy/img?u=${encodeURIComponent(u)}`;
    const result = sanitizeHtml(html, { proxyImageSrc: proxy });
    expect(result).toContain("/worker/image-proxy/img?u=https%3A%2F%2Fcdn.example.com%2Fa.png");
    expect(result).toContain("/worker/image-proxy/img?u=https%3A%2F%2Fcdn.example.com%2Fb.jpg");
    expect(result).not.toMatch(/src="https?:\/\/cdn/);
  });

  it("ne charge aucune image distante sans proxy (indesirables)", () => {
    const html = '<img src="https://cdn.example.com/a.png"><td style="background-image:url(https://cdn.example.com/bg.png)">x</td>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("cdn.example.com");
  });

  it("reecrit aussi les fonds CSS distants", () => {
    const html = '<div style="background:url(\'https://cdn.example.com/bg.png\') no-repeat">x</div>';
    const result = sanitizeHtml(html, { proxyImageSrc: () => "/worker/image-proxy/img?u=bg" });
    expect(result).toContain("/worker/image-proxy/img?u=bg");
    expect(result).not.toContain("cdn.example.com");
  });

  it("retire les pixels espions, meme avec le proxy", () => {
    const html = [
      '<img src="https://t.example.com/a.gif" width="1" height="1">',
      '<img src="https://t.example.com/b.gif" style="display:none">',
      '<img src="https://u1234.ct.sendgrid.net/wf/open?upn=xyz">',
      '<img src="https://x.list-manage.com/track/open.php?u=1">',
      '<img src="https://mail.example.com/track/open/tok123">',
      '<img src="https://cdn.example.com/logo.png" width="16" height="16">',
    ].join("");
    const result = sanitizeHtml(html, { proxyImageSrc: (u) => `/worker/image-proxy/img?u=${encodeURIComponent(u)}` });
    expect((result.match(/<img/g) || []).length).toBe(1);
    expect(result).toContain("logo.png");
  });

  it("ne fait signer que les vraies images (espions exclus)", () => {
    const html = '<img src="https://cdn.example.com/a.png"><img src="https://t.example.com/p.gif" width="1" height="1"><img src="/rel.png"><div style="background-image:url(https://cdn.example.com/bg.png)"></div>';
    expect(collectRemoteImageUrls(html).sort()).toEqual(["https://cdn.example.com/a.png", "https://cdn.example.com/bg.png"]);
  });

  it("autorise les images externes avec allowExternalImages", () => {
    const html = '<img src="https://example.com/image.png">';
    const result = sanitizeHtml(html, { allowExternalImages: true });
    expect(result).toContain("https://example.com/image.png");
  });

  it("force target=_blank sur les liens", () => {
    const html = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it("garde les attributs autorisés (href, alt, class)", () => {
    const html = '<a href="https://test.com" class="link">Link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('href="https://test.com"');
    expect(result).toContain('class="link"');
  });

  it("gere une chaine vide", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("preserve les tableaux HTML", () => {
    const html =
      "<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>";
    const result = sanitizeHtml(html);
    expect(result).toContain("<table>");
    expect(result).toContain("<th>");
    expect(result).toContain("<td>");
  });
});
