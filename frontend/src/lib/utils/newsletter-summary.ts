/**
 * Mise en forme d'une synthese IA de newsletter (HTML genere par
 * `newsletter.ts` cote worker).
 *
 * Les anciennes syntheses suivent l'ordre Source -> Resume -> Au sommaire ->
 * A retenir. L'ecran veut la synthese en tete, "A retenir" juste dessous, puis
 * le sommaire, la source en dernier. Les posts deja generes sont reordonnes ICI
 * a l'affichage (aucun nouvel appel LLM). Les libelles etant rediges dans la
 * langue de l'utilisateur, la detection accepte les variantes fr/en/de/it/es.
 */

type Block = { html: string; label: string; headerOnly: boolean; isList: boolean };

const SOURCE_RE = /^(source|quelle|fonte|fuente|origine)\b/i;
const SUMMARY_RE = /^(r[eé]sum[eé]|synth[eè]se|summary|overview|zusammenfassung|riassunto|sintesi|resumen)\b/i;
const TAKEAWAY_RE =
  /^([aà] retenir|a noter|key takeaways?|takeaways?|to remember|worth remembering|key points|das wichtigste|wichtig|zum merken|merken|da ricordare|punti chiave|da tenere a mente|para recordar|puntos clave)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#?\w+;/g, " ");
}

/** HTML -> texte brut sur une ligne. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLabel(raw: string): string {
  return htmlToText(raw).replace(/\s*:\s*$/, "").trim();
}

/**
 * Decoupe la synthese en blocs de premier niveau (<p>, <ul>, <ol>).
 * Renvoie null si du contenu echappe au decoupage (format inattendu) : on
 * n'ose alors rien reordonner.
 */
function splitBlocks(html: string): Block[] | null {
  const re = /<p\b[^>]*>[\s\S]*?<\/p>|<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi;
  const blocks: Block[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (htmlToText(html.slice(last, m.index))) return null;
    last = m.index + m[0].length;
    const chunk = m[0];
    const isList = !!m[1];
    let label = "";
    let headerOnly = false;
    if (!isList) {
      const strong = /^<p\b[^>]*>\s*<strong>([\s\S]*?)<\/strong>([\s\S]*)<\/p>$/i.exec(chunk);
      if (strong) {
        label = cleanLabel(strong[1]);
        headerOnly = !htmlToText(strong[2]).replace(/^:\s*/, "");
      }
    }
    blocks.push({ html: chunk, label, headerOnly, isList });
  }
  if (htmlToText(html.slice(last))) return null;
  return blocks.length ? blocks : null;
}

type Sections = {
  source: Block[];
  summary: Block[];
  takeaway: Block[];
  rest: Block[];
};

function sectionize(blocks: Block[]): Sections {
  const s: Sections = { source: [], summary: [], takeaway: [], rest: [] };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.label && SOURCE_RE.test(b.label) && !s.source.length) {
      s.source.push(b);
    } else if (b.label && SUMMARY_RE.test(b.label) && !s.summary.length) {
      s.summary.push(b);
    } else if (b.label && b.headerOnly && TAKEAWAY_RE.test(b.label) && !s.takeaway.length) {
      s.takeaway.push(b);
      // Le titre "A retenir" emporte la liste qui le suit.
      while (i + 1 < blocks.length && blocks[i + 1].isList) s.takeaway.push(blocks[++i]);
    } else {
      s.rest.push(b);
    }
  }
  return s;
}

/**
 * Reordonne la synthese : Resume, A retenir, Au sommaire (et le reste), Source.
 * Idempotent : une synthese deja dans le bon ordre ressort a l'identique.
 */
export function reorderNewsletterSummary(html: string): string {
  if (!html) return html;
  const blocks = splitBlocks(html);
  if (!blocks) return html;
  const s = sectionize(blocks);
  if (!s.summary.length && !s.takeaway.length) return html;
  return [...s.summary, ...s.takeaway, ...s.rest, ...s.source].map((b) => b.html).join("\n");
}

/**
 * Texte de la synthese seule (paragraphe "Resume :" sans son libelle), pour la
 * description des cartes. Repli : tout le texte sauf le bloc "Source".
 */
export function newsletterSynthesisText(html: string): string {
  if (!html) return "";
  const blocks = splitBlocks(html);
  if (!blocks) return htmlToText(html);
  const s = sectionize(blocks);
  if (s.summary.length) {
    const m = /^<p\b[^>]*>\s*<strong>[\s\S]*?<\/strong>([\s\S]*)<\/p>$/i.exec(s.summary[0].html);
    const text = htmlToText(m ? m[1] : s.summary[0].html).replace(/^:\s*/, "");
    if (text) return text;
  }
  return htmlToText(
    [...s.takeaway, ...s.rest].map((b) => b.html).join(" ")
  );
}
