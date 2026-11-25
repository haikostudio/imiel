"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  messages,
  getCurrentUserId,
  type Message,
  type Folder,
} from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { fetchMailSearchPage, type MailSearchItem } from "@/lib/mail-search-api";
import {
  buildPocketBaseSearchFilter,
  hasSearchCriterion,
  parseSearchQuery,
} from "@/lib/search-query";

export { parseSearchQuery };

export interface MessageWithFolder extends Message {
  expand?: {
    folder?: Folder;
  };
}

interface UseSearchReturn {
  results: MessageWithFolder[];
  loading: boolean;
  search: (query: string) => Promise<void>;
  /** Nombre EXACT de resultats par type de dossier (null = inconnu, repli PB). */
  counts: Record<string, number> | null;
  /** Index du worker en premiere construction : resultats encore partiels. */
  indexing: { done: number; total: number } | null;
}

/**
 * Filtre PocketBase d'une requete (repli quand le worker est injoignable).
 * N'inclut PAS le filtre par compte (les hooks l'ajoutent deja). Une requete
 * en erreur ne ramene rien.
 */
export function buildSearchFilter(query: string): string {
  return buildPocketBaseSearchFilter(parseSearchQuery(query), null);
}

// La palette charge les 200 resultats les plus recents ; le total exact et la
// repartition par dossier viennent du worker, et "Voir tout" parcourt la liste
// complete, page par page, sans plafond.
const PALETTE_LIMIT = 200;
const SEARCH_TIMEOUT_MS = 8_000;

// Heuristique : une requete "simple" (mot-cle, nom, expediteur) attend un tri
// ANTECHRONOLOGIQUE (les mails recents d'abord, comme Gmail), tandis qu'une
// requete en langage naturel ("quel est le dernier mail de Boris ?") profite du
// tri par pertinence semantique. Regle : <= 3 mots et pas de "?" -> simple.
// Couvre "Infomaniak", "Boris Siegenthaler", "facture edf", les adresses email.
export function isSimpleSearchQuery(freeText: string): boolean {
  const t = freeText.trim();
  if (!t) return false;
  if (t.includes("?")) return false;
  return t.split(/\s+/).length <= 3;
}

// Resultats de palette depuis les lignes du worker (zero requete PB) : le
// type de dossier arrive avec chaque ligne, pour le rangement par dossier.
function toPaletteResults(items: MailSearchItem[]): MessageWithFolder[] {
  return items.map(
    (it) =>
      ({
        ...it,
        expand: it.folder_type ? { folder: { type: it.folder_type } as Folder } : undefined,
      }) as unknown as MessageWithFolder
  );
}

export function useSearch(): UseSearchReturn {
  const [results, setResults] = useState<MessageWithFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null);
  const activeAccountId = useMailStore((s) => s.activeAccountId);

  // Token incremental pour ignorer les reponses de recherches obsoletes (le
  // user tape vite, on a deja un appel hybride en vol quand le suivant part).
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Pre-chauffe le cache vecteurs du worker des le montage (SearchCommand est
  // monte en permanence dans AuthenticatedLayout). Sans ca, la 1ere recherche
  // apres expiration du cache paie ~25s de chargement de 43k vecteurs depuis
  // SQLite ; en warmant en tache de fond au chargement de l'app, l'utilisateur
  // ne voit plus ce cout. Fire-and-forget : aucune erreur ne doit remonter.
  useEffect(() => {
    const userId = getCurrentUserId();
    if (!userId) return;
    void fetch("/worker/embeddings/warm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch(() => {});
  }, []);

  const search = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      // Requete fausse (date invalide, has:pdf...) ou vide : on ne cherche
      // rien ; l'ecran affiche l'erreur (parseSearchQuery().errors).
      const parsedQuery = parseSearchQuery(trimmed);
      if (!trimmed || parsedQuery.errors.length > 0 || !hasSearchCriterion(parsedQuery)) {
        abortRef.current?.abort();
        setResults([]);
        setCounts(null);
        setIndexing(null);
        setLoading(false);
        return;
      }

      // Annule la recherche precedente avant d'en lancer une nouvelle.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const seq = ++requestSeqRef.current;
      const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);

      setLoading(true);
      try {
        // Branche 1 : moteur de recherche du worker. La requete part TELLE
        // QUELLE (operateurs compris) : meme moteur que la liste "Voir tout",
        // donc memes resultats.
        if (getCurrentUserId()) {
          try {
            const found = await fetchMailSearchPage({
              query: trimmed,
              page: 1,
              perPage: PALETTE_LIMIT,
              accountId: activeAccountId,
              signal: ctrl.signal,
            });
            if (seq !== requestSeqRef.current) return;
            setResults(toPaletteResults(found.items));
            setCounts(found.counts);
            setIndexing(
              found.indexing.ready
                ? null
                : { done: found.indexing.done, total: found.indexing.total }
            );
            return;
          } catch {
            // worker injoignable / index indisponible / delai depasse
            if (seq !== requestSeqRef.current) return;
          }
        }

        // Branche 2 : repli PocketBase (LIKE sujet / expediteur / destinataire),
        // tri par -date. Resultats moins complets, mais jamais d'ecran vide a
        // cause d'un worker arrete.
        setCounts(null);
        setIndexing(null);
        const filter = buildPocketBaseSearchFilter(parsedQuery, activeAccountId);
        const result = await messages().getList<MessageWithFolder>(1, 300, {
          filter,
          sort: "-date",
          expand: "folder",
        });
        if (seq !== requestSeqRef.current) return;
        setResults(result.items);
      } catch {
        if (seq === requestSeqRef.current) setResults([]);
      } finally {
        clearTimeout(timer);
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [activeAccountId]
  );

  return { results, loading, search, counts, indexing };
}
