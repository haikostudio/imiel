/// <reference types="vite/client" />
/**
 * Contrat des tiroirs du telephone (vaul `DrawerContent`), verifie sur le
 * SOURCE pour que tout nouveau tiroir suive la regle d'office :
 *  1. en-tete commun : `<DrawerSheetHeader>` (poignee + titre centre +
 *     actions a droite), ou un en-tete propre declare `data-drawer-header="custom"`
 *     (fil de conversation, fiche du suivi) / `"desktop"` (tiroir jamais rendu
 *     sur telephone) ;
 *  2. ancrage sous la barre d'etat : jamais `top-0` / `safe-area-top` /
 *     une hauteur arbitraire calee sur --app-height / `rounded-none` sur le tiroir (les couches
 *     vaul sont portalisees hors de l'app-root : `top-0` les fait passer SOUS
 *     l'heure et la batterie) -> `top-[var(--app-top)]` ou
 *     `sheet-h-full` / `sheet-max-h` ;
 *  3. pas de fraction d'ecran (`*0.85`...) pour un tiroir de telephone, sauf
 *     variante `data-[contained=true]:` / `sm:` / `md:` (ordinateur) ;
 *  4. une seule poignee : un tiroir qui rend sa prise pose `hideGrip` ;
 *  5. plus de `SheetContent side="bottom"` (tiroir Radix maison) ;
 *  6. AUCUNE croix de fermeture dans un tiroir du telephone : on le ferme en
 *     glissant sa poignee vers le bas (vaul -> onOpenChange). Ni
 *     `DrawerClose`, ni `data-drawer-close`, ni `leading="close"` (croix du
 *     kit), ni `onClose=`/`closeDataRef=` passe a l'en-tete commun.
 */
import { describe, it, expect } from "vitest";

// Sources brutes de tous les composants (Vite : aucune lecture disque).
const SOURCES = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const FILES = Object.keys(SOURCES).map((k) => k.replace(/^\/src\//, ""));

/** Fin de la balise ouvrante JSX qui commence a `start` (ignore les `>` dans {}/""). */
function openingTagEnd(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    // Commentaires JS dans une expression {} : leurs apostrophes ne sont pas
    // des chaines.
    if (depth > 0 && c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (depth > 0 && c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i === 0) return -1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

interface DrawerSite {
  file: string;
  line: number;
  tag: string;
  body: string;
}

function collectDrawers(): DrawerSite[] {
  const sites: DrawerSite[] = [];
  for (const rel of FILES) {
    if (rel === "components/ui/drawer.tsx") continue;
    const src = SOURCES[`/src/${rel}`];
    let idx = 0;
    while ((idx = src.indexOf("<DrawerContent", idx)) !== -1) {
      const next = src[idx + "<DrawerContent".length];
      if (!/[\s>]/.test(next)) {
        idx++;
        continue;
      }
      const tagEnd = openingTagEnd(src, idx);
      if (tagEnd === -1) throw new Error(`balise <DrawerContent> illisible : ${rel}`);
      const close = src.indexOf("</DrawerContent>", tagEnd);
      sites.push({
        file: rel,
        line: src.slice(0, idx).split("\n").length,
        tag: src.slice(idx, tagEnd + 1),
        body: src.slice(tagEnd + 1, close === -1 ? undefined : close),
      });
      idx = tagEnd;
    }
  }
  return sites;
}

const drawers = collectDrawers();
const where = (d: DrawerSite) => `${d.file}:${d.line}`;

describe("contrat des tiroirs du telephone", () => {
  it("trouve les tiroirs de l'application", () => {
    expect(drawers.length).toBeGreaterThan(10);
  });

  it("chaque tiroir porte l'en-tete commun (ou un en-tete propre declare)", () => {
    const missing = drawers
      .filter((d) => !d.body.includes("<DrawerSheetHeader") && !/data-drawer-header="(custom|desktop)"/.test(d.body))
      .map(where);
    expect(missing).toEqual([]);
  });

  it("aucun tiroir ne part du haut de l'ecran (sous la barre d'etat)", () => {
    const banned = /(^|[\s"'`])(top-0|safe-area-top|rounded-none)(?=[\s"'`]|$)|h-\[var\(--app-height/;
    const bad = drawers.filter((d) => banned.test(d.tag)).map(where);
    expect(bad).toEqual([]);
  });

  it("aucune fraction d'ecran pour un tiroir de telephone", () => {
    const bad = drawers
      .filter((d) => !d.body.includes('data-drawer-header="desktop"'))
      .filter((d) =>
        (d.tag.match(/[^\s"'`]*\*0\.\d+[^\s"'`]*/g) ?? []).some(
          (tok) => !/^(data-\[contained=true\]|sm|md|lg):/.test(tok)
        )
      )
      .map(where);
    expect(bad).toEqual([]);
  });

  it("une seule poignee : la prise rendue s'accompagne de hideGrip", () => {
    const bad = drawers
      .filter((d) => /<DrawerSheetHeader|<DrawerHandle/.test(d.body) && !/\bhideGrip\b/.test(d.tag))
      .map(where);
    expect(bad).toEqual([]);
  });

  it("aucune croix de fermeture dans un tiroir du telephone", () => {
    const banned =
      /<DrawerClose\b|data-drawer-close|leading="close"|leading=\{[^}]*"close"|<DrawerSheetHeader\b[^>]*\b(onClose|closeDataRef|closeLabel)=/;
    const bad = drawers
      .filter((d) => !d.body.includes('data-drawer-header="desktop"'))
      .filter((d) => banned.test(d.body))
      .map(where);
    expect(bad).toEqual([]);
  });

  it("l'en-tete commun ne rend plus de croix", async () => {
    const src = (await import("/src/components/ui/drawer.tsx?raw")).default as string;
    const header = src.slice(src.indexOf("function DrawerSheetHeader"), src.indexOf("function DrawerTitle"));
    expect(header).not.toMatch(/data-drawer-close|DrawerPrimitive\.Close|<X\b/);
  });

  it("plus de tiroir Radix maison qui monte du bas", () => {
    const bad = FILES.filter((f) => !f.startsWith("components/ui/")).filter((f) =>
      /<SheetContent[^>]*side="bottom"/.test(SOURCES[`/src/${f}`])
    );
    expect(bad).toEqual([]);
  });
});
