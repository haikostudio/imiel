// Parse les references temporelles dans une question utilisateur et renvoie
// une fenetre de dates [from, to]. Si aucune reference trouvee, retourne null.
//
// Couvre FR / EN / DE / IT (les 4 langues UI du projet) sur les formes
// courantes : "il y a 8 mois", "en avril", "en avril 2024", "l'ete dernier",
// "depuis janvier", "2024", "novembre 2024", etc.
//
// Utilise par /api/ai/chat pour transmettre une dateWindow au worker, qui
// elargit la recherche RAG sur la periode demandee (au lieu de couper aux
// 25k mails les plus recents).

export interface DateWindow {
  from: string; // ISO date YYYY-MM-DD (inclusive)
  to: string;   // ISO date YYYY-MM-DD (inclusive)
  label: string; // libelle humain pour le bandeau UI ("avril 2025", "il y a 8 mois")
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmt(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function monthRange(year: number, monthIdx: number): { from: Date; to: Date } {
  const from = new Date(Date.UTC(year, monthIdx, 1));
  const to = new Date(Date.UTC(year, monthIdx + 1, 0));
  return { from, to };
}

function stripAccents(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

// Mois -> index 0-11. Sans accents. Couvre FR + EN + DE + IT (formes courantes).
const MONTH_NAMES: Record<string, number> = {
  // FR
  janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11,
  janv: 0, fev: 1, avr: 3, juil: 6, sept: 8, oct: 9, nov: 10, dec: 11,
  // EN
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, apr: 3, jul: 6, aug: 7, // mai/may, sept/sep, oct/oct, nov/nov, dec/dec deja couverts
  may: 4, sep: 8,
  // DE
  januar: 0, februar: 1, marz: 2, juni: 5, juli: 6, oktober: 9, dezember: 11,
  marz_: 2, // garde-fou (accent strippe deja)
  // IT
  gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
  luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre_: 10, dicembre: 11,
};

const MONTH_LABEL: Record<number, string> = {
  0: "janvier", 1: "fevrier", 2: "mars", 3: "avril", 4: "mai", 5: "juin",
  6: "juillet", 7: "aout", 8: "septembre", 9: "octobre", 10: "novembre",
  11: "decembre",
};

// Saisons (hemisphere nord) - mois inclusifs
const SEASONS: Record<string, { months: [number, number]; label: string }> = {
  printemps: { months: [2, 4], label: "printemps" }, // mars-mai
  spring: { months: [2, 4], label: "printemps" },
  fruhling: { months: [2, 4], label: "printemps" },
  primavera: { months: [2, 4], label: "printemps" },
  ete: { months: [5, 7], label: "ete" }, // juin-aout
  summer: { months: [5, 7], label: "ete" },
  sommer: { months: [5, 7], label: "ete" },
  estate: { months: [5, 7], label: "ete" },
  automne: { months: [8, 10], label: "automne" }, // sept-nov
  autumn: { months: [8, 10], label: "automne" },
  fall: { months: [8, 10], label: "automne" },
  herbst: { months: [8, 10], label: "automne" },
  autunno: { months: [8, 10], label: "automne" },
  hiver: { months: [11, 1], label: "hiver" }, // dec-fev (chevauche annee)
  winter: { months: [11, 1], label: "hiver" },
  inverno: { months: [11, 1], label: "hiver" },
};

/**
 * Parse une question et renvoie la fenetre temporelle reperee. Retourne null
 * si aucune reference. Si plusieurs references sont presentes, prend la plus
 * specifique en premier (annee+mois > mois seul > saison > "il y a N mois").
 *
 * @param now date de reference (defaut: maintenant) — utile pour les tests.
 */
export function parseDateWindow(
  query: string,
  now: Date = new Date()
): DateWindow | null {
  if (!query || query.trim() === "") return null;
  const q = stripAccents(query);
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth();

  // 1. "mois YYYY" : "avril 2025", "april 2024", "marzo 2023"
  for (const [name, idx] of Object.entries(MONTH_NAMES)) {
    const re = new RegExp(`\\b${name}\\s+(20\\d{2})\\b`);
    const m = q.match(re);
    if (m) {
      const year = Number(m[1]);
      const { from, to } = monthRange(year, idx);
      return {
        from: fmt(from),
        to: fmt(to),
        label: `${MONTH_LABEL[idx]} ${year}`,
      };
    }
  }

  // 2. "YYYY" seul (annee complete) : "en 2024", "2023"
  const yearMatch = q.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return {
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      label: `${year}`,
    };
  }

  // 3. "il y a N mois/ans/semaines" / "vor N monaten" / "N months ago" / "N mesi fa"
  const agoMatch = q.match(
    /(?:il y a|vor|ago|fa)\s*(\d{1,3})\s*(mois|month|monat|mese|mesi|an|annee|year|jahr|anno|anni|semaine|week|woche|settimana)|(\d{1,3})\s*(mois|month|monat|mese|mesi|an|annee|year|jahr|anno|anni|semaine|week|woche|settimana)\s*(?:ago|fa|zuruck)/
  );
  if (agoMatch) {
    const n = Number(agoMatch[1] || agoMatch[3]);
    const unit = (agoMatch[2] || agoMatch[4] || "").toLowerCase();
    if (/^(mois|month|monat|mese|mesi)$/.test(unit)) {
      const target = new Date(Date.UTC(Y, M - n, 1));
      const from = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1));
      const to = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
      // Elargir +/- 15 jours pour absorber l'imprecision
      from.setUTCDate(from.getUTCDate() - 15);
      to.setUTCDate(to.getUTCDate() + 15);
      return {
        from: fmt(from),
        to: fmt(to),
        label: `il y a ${n} mois`,
      };
    }
    if (/^(an|annee|year|jahr|anno|anni)$/.test(unit)) {
      const target = new Date(Date.UTC(Y - n, 0, 1));
      return {
        from: fmt(target),
        to: `${target.getUTCFullYear()}-12-31`,
        label: `il y a ${n} an${n > 1 ? "s" : ""}`,
      };
    }
    if (/^(semaine|week|woche|settimana)$/.test(unit)) {
      const to = new Date(Date.UTC(Y, M, now.getUTCDate()));
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - n * 7);
      return {
        from: fmt(from),
        to: fmt(to),
        label: `il y a ${n} semaine${n > 1 ? "s" : ""}`,
      };
    }
  }

  // 4. Saisons : "l'ete dernier", "summer 2024", "im sommer", "estate scorsa"
  for (const [key, season] of Object.entries(SEASONS)) {
    const re = new RegExp(
      `\\b(l'?|im|in|au|cet|the)?\\s*${key}\\b(?:\\s+(dernier|passe|last|letzten?|scorso|scorsa))?(?:\\s+(20\\d{2}))?`
    );
    const m = q.match(re);
    if (m) {
      const explicitYear = m[3] ? Number(m[3]) : null;
      const isPast = !!m[2] || (explicitYear !== null && explicitYear < Y);
      const baseYear = explicitYear ?? (isPast ? Y - 1 : Y);
      const [m1, m2] = season.months;
      // Saison qui chevauche le nouvel an (ex: hiver dec-fev)
      let from: Date;
      let to: Date;
      if (m2 < m1) {
        from = new Date(Date.UTC(baseYear, m1, 1));
        to = new Date(Date.UTC(baseYear + 1, m2 + 1, 0));
      } else {
        from = new Date(Date.UTC(baseYear, m1, 1));
        to = new Date(Date.UTC(baseYear, m2 + 1, 0));
      }
      return {
        from: fmt(from),
        to: fmt(to),
        label: `${season.label}${explicitYear ? ` ${explicitYear}` : isPast ? " dernier" : ""}`,
      };
    }
  }

  // 5. "mois" seul (sans annee) : "en avril", "in april", "ad aprile"
  // -> annee courante si le mois est passe ou en cours, sinon annee precedente
  for (const [name, idx] of Object.entries(MONTH_NAMES)) {
    const re = new RegExp(`\\b(?:en|in|im|au mois d['e]|nel mese di|ad)\\s+${name}\\b`);
    if (re.test(q)) {
      const year = idx <= M ? Y : Y - 1;
      const { from, to } = monthRange(year, idx);
      return {
        from: fmt(from),
        to: fmt(to),
        label: `${MONTH_LABEL[idx]} ${year}`,
      };
    }
  }

  // 6. "depuis MOIS" / "since MONTH" / "seit MONAT" / "da MESE"
  // -> fenetre du mois cite (annee courante ou precedente) jusqu'a aujourd'hui
  for (const [name, idx] of Object.entries(MONTH_NAMES)) {
    const re = new RegExp(`\\b(?:depuis|since|seit|da|dal)\\s+${name}\\b`);
    if (re.test(q)) {
      const year = idx <= M ? Y : Y - 1;
      const from = new Date(Date.UTC(year, idx, 1));
      const to = new Date(Date.UTC(Y, M, now.getUTCDate()));
      return {
        from: fmt(from),
        to: fmt(to),
        label: `depuis ${MONTH_LABEL[idx]} ${year}`,
      };
    }
  }

  // 7. "depuis N mois/semaines" — fenetre [now - N, now]
  const sinceMatch = q.match(
    /(?:depuis|since|seit|da)\s*(\d{1,3})\s*(mois|month|monat|mese|mesi|semaine|week|woche|settimana|jour|day|tag|giorno|giorni)/
  );
  if (sinceMatch) {
    const n = Number(sinceMatch[1]);
    const unit = sinceMatch[2].toLowerCase();
    const to = new Date(Date.UTC(Y, M, now.getUTCDate()));
    const from = new Date(to);
    if (/^(mois|month|monat|mese|mesi)$/.test(unit)) {
      from.setUTCMonth(from.getUTCMonth() - n);
    } else if (/^(semaine|week|woche|settimana)$/.test(unit)) {
      from.setUTCDate(from.getUTCDate() - n * 7);
    } else {
      from.setUTCDate(from.getUTCDate() - n);
    }
    return {
      from: fmt(from),
      to: fmt(to),
      label: `depuis ${n} ${unit}`,
    };
  }

  // 8. "annee derniere" / "last year" / "letztes jahr" / "anno scorso"
  if (
    /\b(annee\s+derniere|annee\s+passee|last\s+year|letztes\s+jahr|anno\s+scorso)\b/.test(q)
  ) {
    return {
      from: `${Y - 1}-01-01`,
      to: `${Y - 1}-12-31`,
      label: `${Y - 1}`,
    };
  }

  // 9. "mois dernier" / "last month" / "letzten monat" / "mese scorso"
  if (
    /\b(mois\s+dernier|mois\s+passe|last\s+month|letzten\s+monat|mese\s+scorso)\b/.test(
      q
    )
  ) {
    const target = new Date(Date.UTC(Y, M - 1, 1));
    const from = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1));
    const to = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
    return {
      from: fmt(from),
      to: fmt(to),
      label: `${MONTH_LABEL[target.getUTCMonth()]} ${target.getUTCFullYear()}`,
    };
  }

  // 10. Recence vague : "recemment", "dernierement", "ces derniers jours/
  // semaines/mois", "recently", "lately"... -> fenetre glissante recente.
  // Sans ca, "l'achat que j'ai fait dernierement" part en echantillonnage
  // chronologique sur TOUTE la boite (10 ans) et noie les mails recents.
  const to10 = new Date(Date.UTC(Y, M, now.getUTCDate()));
  const recentWindow = (days: number, label: string): DateWindow => {
    const from = new Date(to10);
    from.setUTCDate(from.getUTCDate() - days);
    return { from: fmt(from), to: fmt(to10), label };
  };
  if (/\b(ces\s+derniers\s+jours|derniers\s+jours|last\s+few\s+days|letzten\s+tagen?|ultimi\s+giorni)\b/.test(q)) {
    return recentWindow(14, "ces derniers jours");
  }
  if (/\b(ces\s+dernieres\s+semaines|dernieres\s+semaines|last\s+few\s+weeks|letzten\s+wochen|ultime\s+settimane)\b/.test(q)) {
    return recentWindow(45, "ces dernieres semaines");
  }
  if (/\b(ces\s+derniers\s+mois|derniers\s+mois|last\s+few\s+months|letzten\s+monaten|ultimi\s+mesi)\b/.test(q)) {
    return recentWindow(120, "ces derniers mois");
  }
  if (/\b(recemment|dernierement|recently|lately|kurzlich|neulich|recentemente|ultimamente|di\s+recente)\b/.test(q)) {
    return recentWindow(60, "recemment");
  }

  return null;
}
