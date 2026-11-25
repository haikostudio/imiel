// Signatures par compte : HTML stocke dans accounts.signature (compatible
// messageries : styles INLINE, mise en page en <table>), images servies par le
// champ fichier public accounts.signature_images (migration 066).
//
// Dans un brouillon, la signature vit HORS de l'editeur (comme l'historique
// cite) : elle est enveloppee dans <div class="haiko-signature"> et concatenee
// au corps a l'auto-save et a l'envoi (corps + signature + citation). La classe
// survit a DOMPurify (contrairement aux data-*), ce qui permet de la re-separer
// au rechargement d'un brouillon : jamais de seconde signature.
import type { Account } from "@/lib/pocketbase";

export const SIGNATURE_MARKER_CLASS = "haiko-signature";

const SIGNATURE_WRAPPER_STYLE = "margin-top:16px;";

/** Texte visible (sans balises) d'un fragment HTML. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Une signature est vide si elle n'a ni texte ni image. */
export function isSignatureEmpty(html: string | null | undefined): boolean {
  if (!html) return true;
  if (/<img\b/i.test(html)) return false;
  return visibleText(html) === "";
}

/** Signature du compte (chaine vide si absente). */
export function accountSignature(account: Pick<Account, "signature"> | null | undefined): string {
  const sig = account?.signature ?? "";
  return isSignatureEmpty(sig) ? "" : sig;
}

/** Bloc signature pret a etre concatene au corps d'un brouillon. */
export function wrapSignature(html: string): string {
  if (isSignatureEmpty(html)) return "";
  return `<div class="${SIGNATURE_MARKER_CLASS}" style="${SIGNATURE_WRAPPER_STYLE}">${html}</div>`;
}

/**
 * Separe la partie redigee du bloc signature (rechargement d'un brouillon).
 * A appeler APRES avoir retire la citation (splitQuotedBody) : un message cite
 * peut lui-meme contenir une ancienne signature.
 */
export function splitSignature(html: string): { body: string; signature: string } {
  if (typeof window === "undefined" || !html || !html.includes(SIGNATURE_MARKER_CLASS)) {
    return { body: html ?? "", signature: "" };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const el = doc.querySelector(`.${SIGNATURE_MARKER_CLASS}`);
  if (!el) return { body: html, signature: "" };
  const signature = el.innerHTML;
  el.remove();
  return { body: doc.body.innerHTML.trim(), signature };
}

/** Recompose corps + signature (la citation se rajoute ensuite). */
export function joinSignature(body: string, signature: string): string {
  const block = wrapSignature(signature);
  if (!block) return body ?? "";
  return `${body ?? ""}${block}`;
}

function appendStyle(el: Element, css: string) {
  const prev = (el.getAttribute("style") || "").trim();
  const sep = prev && !prev.endsWith(";") ? ";" : "";
  el.setAttribute("style", `${prev}${sep}${css}`);
}

/**
 * HTML de l'editeur -> HTML de signature compatible messageries : paragraphes
 * sans marge, grille en table de presentation (cellules alignees en haut,
 * gouttiere a droite), images en bloc a largeur fixe. Idempotent : les styles
 * ajoutes ne sont relus ni par l'editeur ni par cette fonction.
 */
export function toEmailSignatureHtml(editorHtml: string): string {
  if (isSignatureEmpty(editorHtml)) return "";
  if (typeof window === "undefined") return editorHtml;
  const doc = new DOMParser().parseFromString(`<div>${editorHtml}</div>`, "text/html");
  const root = doc.body.firstElementChild as HTMLElement;

  root.querySelectorAll("colgroup").forEach((el) => el.remove());
  root.querySelectorAll("table").forEach((table) => {
    table.removeAttribute("style");
    table.setAttribute("role", "presentation");
    table.setAttribute("cellpadding", "0");
    table.setAttribute("cellspacing", "0");
    table.setAttribute("border", "0");
    table.setAttribute("style", "border-collapse:collapse;");
  });
  root.querySelectorAll("td, th").forEach((cell) => {
    const isLast = !cell.nextElementSibling;
    cell.removeAttribute("colwidth");
    cell.setAttribute("valign", "top");
    cell.setAttribute(
      "style",
      `vertical-align:top;padding:0 ${isLast ? "0" : "16px"} 0 0;`
    );
  });
  root.querySelectorAll("p").forEach((p) => {
    const align = (p as HTMLElement).style.textAlign;
    p.setAttribute("style", `margin:0;${align ? `text-align:${align};` : ""}`);
    // Paragraphe vide : garde une ligne blanche visible chez le destinataire.
    if (!p.innerHTML.trim()) p.innerHTML = "<br>";
  });
  root.querySelectorAll("img").forEach((img) => {
    const w = parseInt(img.getAttribute("width") || "", 10);
    img.removeAttribute("height");
    img.setAttribute(
      "style",
      `display:block;border:0;outline:none;height:auto;max-width:100%;${w > 0 ? `width:${w}px;` : ""}`
    );
    if (!img.getAttribute("alt")) img.setAttribute("alt", "");
  });
  root.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    const css = (a as HTMLElement).style;
    if (!css.color) appendStyle(a, "color:#2563eb;");
  });
  return root.innerHTML;
}

/**
 * URL PUBLIQUE absolue d'une image de signature : chez le destinataire, elle
 * doit se charger sans jeton, depuis l'adresse de l'application (qui relaie
 * /api/files vers PocketBase).
 */
export function signatureImageUrl(
  account: Pick<Account, "id" | "collectionId">,
  filename: string,
  origin: string = typeof window !== "undefined" ? window.location.origin : ""
): string {
  return `${origin.replace(/\/+$/, "")}/api/files/${account.collectionId}/${account.id}/${encodeURIComponent(filename)}`;
}
