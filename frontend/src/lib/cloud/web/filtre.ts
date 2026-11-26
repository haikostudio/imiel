// Filtres PocketBase evalues DANS LE NAVIGATEUR (app web iMiel Cloud) : meme
// grammaire que l'API de la base (`a = "x" && (b ~ "y" || c >= 3)`), sur des
// fiches en memoire. Champs de relation suivis par leur identifiant
// (`folder.type`, `message.account.user`), operateurs « au moins un » (`?=`).

export type Fiche = Record<string, unknown> & { id: string };
export type Resolveur = (col: string, champ: string, valeur: unknown) => Fiche | null;

type Jeton = { t: "id" | "str" | "num" | "op" | "par" | "et" | "ou" | "lit"; v: string };

const OPS = ["?!=", "?>=", "?<=", "?!~", "?=", "?>", "?<", "?~", "!=", ">=", "<=", "!~", "=", ">", "<", "~"];

function lexer(src: string): Jeton[] {
  const out: Jeton[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: "par", v: c });
      i++;
      continue;
    }
    if (src.startsWith("&&", i)) {
      out.push({ t: "et", v: "&&" });
      i += 2;
      continue;
    }
    if (src.startsWith("||", i)) {
      out.push({ t: "ou", v: "||" });
      i += 2;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          v += src[j + 1];
          j += 2;
        } else v += src[j++];
      }
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    const m = src.slice(i).match(/^-?\d+(\.\d+)?/);
    if (m && !/[A-Za-z_@]/.test(src[i + m[0].length] || "")) {
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[@A-Za-z_][\w.:@]*/);
    if (id) {
      const v = id[0];
      out.push(v === "true" || v === "false" || v === "null" ? { t: "lit", v } : { t: "id", v });
      i += v.length;
      continue;
    }
    throw new Error(`filtre illisible pres de « ${src.slice(i, i + 12)} »`);
  }
  return out;
}

type Noeud =
  | { k: "et" | "ou"; g: Noeud; d: Noeud }
  | { k: "cmp"; op: string; g: Jeton; d: Jeton };

function analyser(jetons: Jeton[]): Noeud | null {
  let p = 0;
  const regarder = () => jetons[p];
  function expr(): Noeud {
    let g = terme();
    while (regarder()?.t === "ou") {
      p++;
      g = { k: "ou", g, d: terme() };
    }
    return g;
  }
  function terme(): Noeud {
    let g = facteur();
    while (regarder()?.t === "et") {
      p++;
      g = { k: "et", g, d: facteur() };
    }
    return g;
  }
  function facteur(): Noeud {
    const j = regarder();
    if (j?.t === "par" && j.v === "(") {
      p++;
      const e = expr();
      p++; // )
      return e;
    }
    const g = jetons[p++];
    const op = jetons[p++];
    const d = jetons[p++];
    if (!g || !op || op.t !== "op" || !d) throw new Error("filtre incomplet");
    return { k: "cmp", op: op.v, g, d };
  }
  if (!jetons.length) return null;
  return expr();
}

const cache = new Map<string, Noeud | null>();

/** Datetime PocketBase (« 2026-01-02 03:04:05.000Z ») ; les ISO « T » y sont ramenes. */
export function datePb(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/);
  if (!m) return v;
  const ms = (m[3] || ".000").slice(0, 4).padEnd(4, "0");
  return `${m[1]} ${m[2]}${ms}Z`;
}

export interface Contexte {
  col: string;
  auth: string;
  resoudre: Resolveur;
  maintenant?: Date;
}

function valeurChemin(fiche: Fiche | null, chemin: string, ctx: Contexte, col: string): unknown[] {
  if (!fiche) return [""];
  const [champ, ...reste] = chemin.split(".");
  const [nom, modif] = champ.split(":");
  let v = nom === "id" ? fiche.id : fiche[nom];
  if (modif === "length") return [Array.isArray(v) ? v.length : 0];
  if (!reste.length) return Array.isArray(v) ? (v.length ? v : [""]) : [v === undefined || v === null ? "" : v];
  // Relation (simple ou multiple) : on suit chaque identifiant.
  const ids = Array.isArray(v) ? v : [v];
  const out: unknown[] = [];
  for (const id of ids) {
    const cible = ctx.resoudre(col, nom, id);
    if (!cible) {
      out.push("");
      continue;
    }
    out.push(...valeurChemin(cible, reste.join("."), ctx, String(cible.collectionName || "")));
  }
  return out.length ? out : [""];
}

function valeurs(j: Jeton, fiche: Fiche, ctx: Contexte): unknown[] {
  switch (j.t) {
    case "str":
      return [datePb(j.v)];
    case "num":
      return [Number(j.v)];
    case "lit":
      return [j.v === "true" ? true : j.v === "false" ? false : ""];
    case "id": {
      if (j.v === "@request.auth.id") return [ctx.auth];
      if (j.v.startsWith("@request.auth.")) return [""];
      if (j.v === "@now") return [datePb((ctx.maintenant || new Date()).toISOString())];
      if (j.v === "@todayStart") {
        const d = ctx.maintenant || new Date();
        return [datePb(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString())];
      }
      return valeurChemin(fiche, j.v, ctx, ctx.col);
    }
    default:
      return [""];
  }
}

function norm(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return datePb(v);
}

function comparer(op: string, a: unknown, b: unknown): boolean {
  let x = norm(a);
  let y = norm(b);
  if (typeof x === "boolean" && typeof y !== "boolean") y = y === "true" || y === 1;
  if (typeof y === "boolean" && typeof x !== "boolean") x = x === "true" || x === 1 || x === true;
  if (typeof x === "number" && typeof y === "string" && y !== "" && !isNaN(Number(y))) y = Number(y);
  if (typeof y === "number" && typeof x === "string") x = x === "" ? 0 : Number(x);
  switch (op) {
    case "=":
      return x === y;
    case "!=":
      return x !== y;
    case ">":
      return (x as number) > (y as number);
    case ">=":
      return (x as number) >= (y as number);
    case "<":
      return (x as number) < (y as number);
    case "<=":
      return (x as number) <= (y as number);
    case "~":
    case "!~": {
      const motif = String(y).toLowerCase();
      const re = motif.includes("%")
        ? new RegExp("^" + motif.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s")
        : null;
      const s = String(x).toLowerCase();
      const ok = re ? re.test(s) : s.includes(motif);
      return op === "~" ? ok : !ok;
    }
    default:
      return false;
  }
}

function evaluer(n: Noeud, fiche: Fiche, ctx: Contexte): boolean {
  if (n.k !== "cmp") return n.k === "et" ? evaluer(n.g, fiche, ctx) && evaluer(n.d, fiche, ctx) : evaluer(n.g, fiche, ctx) || evaluer(n.d, fiche, ctx);
  const g = valeurs(n.g, fiche, ctx);
  const d = valeurs(n.d, fiche, ctx);
  const auMoinsUn = n.op.startsWith("?");
  const op = auMoinsUn ? n.op.slice(1) : n.op;
  // Champ multiple : « ~ » cherche dans la liste ; « = » sur une liste vaut « au moins un ».
  if (auMoinsUn || g.length > 1) return g.some((a) => d.some((b) => comparer(op, a, b)));
  return d.some((b) => comparer(op, g[0], b));
}

export function filtrer(filtre: string | null | undefined, fiche: Fiche, ctx: Contexte): boolean {
  if (!filtre || !filtre.trim()) return true;
  let n = cache.get(filtre);
  if (n === undefined) {
    n = analyser(lexer(filtre));
    if (cache.size > 500) cache.clear();
    cache.set(filtre, n);
  }
  return n ? evaluer(n, fiche, ctx) : true;
}

/** Tri PocketBase : « -date,created ». */
export function trier(fiches: Fiche[], tri: string | null | undefined): Fiche[] {
  if (!tri) return fiches;
  const cles = tri
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c.startsWith("-") ? { champ: c.slice(1), sens: -1 } : { champ: c.replace(/^\+/, ""), sens: 1 }));
  return fiches.sort((a, b) => {
    for (const { champ, sens } of cles) {
      if (champ === "@random") return Math.random() - 0.5;
      const x = norm(a[champ]) as string | number;
      const y = norm(b[champ]) as string | number;
      if (x < y) return -sens;
      if (x > y) return sens;
    }
    return 0;
  });
}
