"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Clock,
  FileText,
  Inbox,
  Info,
  Loader2,
  MessageSquare,
  PenLine,
  Send,
  Star,
  Trash2,
  AlertTriangle,
  Folder,
  Paperclip,
  User,
  CalendarDays,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { useHashRouter } from "@/lib/hash-router";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useMailStore } from "@/lib/stores/mail-store";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/hooks/useSettings";
import { useSearch, type MessageWithFolder } from "@/lib/hooks/useSearch";
import {
  EMPTY_CHIPS,
  composeSearchQuery,
  normalizeSearchDate,
  parseSearchQuery,
  splitChipsFromQuery,
  type SearchChips,
} from "@/lib/search-query";
import {
  calendarEvents,
  contacts as contactsCollection,
  getCurrentUserId,
  type CalendarEvent,
  type Contact,
} from "@/lib/pocketbase";
import { Chip, ChipRow, SearchField } from "@/components/ui/kit";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/utils/date";
import { stripReplacementChars } from "@/lib/utils/sanitize";
import { cn } from "@/lib/utils";

const RECENT_SEARCHES_KEY = "imiel:recent-searches";
const MAX_RECENT = 5;

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-US", de: "de-DE", it: "it-IT" };

// Normalise pour une recherche tolerante : minuscules + suppression des
// accents/diacritiques (NFD + retrait des marques combinantes).
function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatEventDate(event: CalendarEvent, locale: string): string {
  const d = new Date(event.start);
  if (event.all_day) {
    return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(query: string) {
  try {
    const recent = getRecentSearches();
    const filtered = recent.filter((s) => s !== query);
    const updated = [query, ...filtered].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  } catch {
    // Silencieux
  }
}

const SEARCH_TIPS = [
  { key: "from", example: "from:alice@example.com" },
  { key: "to", example: "to:bob@example.com" },
  { key: "subject", example: "subject:facture" },
  { key: "attachment", example: "has:attachment" },
  { key: "unread", example: "is:unread" },
  { key: "starred", example: "is:starred" },
  { key: "date", example: "after:2025-01-01" },
  { key: "freeText", example: "reunion budget" },
] as const;

// Pastille Date : periodes toutes faites (borne de debut, fin ouverte).
const DATE_PRESETS = [
  { key: "last7", days: 7 },
  { key: "last30", days: 30 },
  { key: "thisYear", days: null },
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** AAAA-MM-JJ du jour local (pas UTC : "7 derniers jours" se compte ici). */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function presetAfter(days: number | null): string {
  const now = new Date();
  if (days === null) return `${now.getFullYear()}-01-01`;
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

function formatDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(y, m - 1, d)
  );
}

/** Garde le focus dans le champ (clavier du telephone ouvert) au toucher d'une pastille. */
const keepInputFocus = (e: React.MouseEvent) => e.preventDefault();

const FOLDER_ORDER: string[] = [
  "inbox",
  "sent",
  "drafts",
  "starred",
  "archive",
  "spam",
  "trash",
  "custom",
];

const FOLDER_ICONS: Record<string, React.ElementType> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  starred: Star,
  archive: Archive,
  spam: AlertTriangle,
  trash: Trash2,
  custom: Folder,
};

export function SearchCommand() {
  const t = useT();
  const { navigate } = useHashRouter();
  const { searchOpen, closeSearch, setSearchQuery, selectMessage, lockSelection, openCompose } =
    useMailStore();
  const { results, loading, search, counts, indexing } = useSearch();
  const language = useSettingsStore((s) => s.language);
  const locale = LOCALES[language] || "en-US";
  // Texte saisi + filtres des pastilles : la requete envoyee au moteur est
  // leur composition (composeSearchQuery), verifiee par parseSearchQuery.
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<SearchChips>(EMPTY_CHIPS);
  const [previousState, setPreviousState] = useState<{ query: string; chips: SearchChips } | null>(
    null
  );
  // Sous-panneau ouvert sous les pastilles (choix d'expediteur ou de periode).
  const [panel, setPanel] = useState<"from" | "date" | null>(null);
  const [fromInput, setFromInput] = useState("");
  const [fromOptions, setFromOptions] = useState<Contact[]>([]);
  const [draftAfter, setDraftAfter] = useState("");
  const [draftBefore, setDraftBefore] = useState("");
  const effectiveQuery = useMemo(() => composeSearchQuery(chips, query), [chips, query]);
  const parsed = useMemo(() => parseSearchQuery(effectiveQuery), [effectiveQuery]);
  const queryErrors = parsed.errors;
  const hasQuery = effectiveQuery.trim() !== "";
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  // Index local des evenements : on charge ceux de l'utilisateur a l'ouverture
  // de la palette et on filtre cote client. Permet une recherche tolerante aux
  // accents et aux mots non contigus (ex: "etat lieux" -> "Etats des lieux..."),
  // impossible avec le `~` (LIKE contigu et sensible aux accents) de PocketBase.
  const [eventIndex, setEventIndex] = useState<{ event: CalendarEvent; hay: string }[]>([]);
  // Resultats compacts : on n'affiche que les en-tetes de theme ; chaque theme
  // s'ouvre a la demande. `expanded` = themes deplies (cle = "contacts",
  // "events", ou type de dossier).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleSection = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const userId = getCurrentUserId();
    if (!userId) return;
    let cancelled = false;
    calendarEvents()
      .getList<CalendarEvent>(1, 2000, {
        filter: `user = "${userId}" && status != "cancelled"`,
        sort: "-start",
      })
      .then((res) => {
        if (cancelled) return;
        setEventIndex(
          res.items.map((event) => ({
            event,
            hay: normalizeText(`${event.title} ${event.description} ${event.location}`),
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setEventIndex([]);
      });
    return () => {
      cancelled = true;
    };
  }, [searchOpen]);

  // Matching : chaque mot de la requete (normalise) doit apparaitre quelque part
  // (titre/desc/lieu). Tri par proximite temporelle avec aujourd'hui.
  const eventResults = useMemo(() => {
    const tokens = normalizeText(query.trim()).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const now = Date.now();
    return eventIndex
      .filter(({ hay }) => tokens.every((tok) => hay.includes(tok)))
      .sort(
        (a, b) =>
          Math.abs(+new Date(a.event.start) - now) - Math.abs(+new Date(b.event.start) - now)
      )
      .slice(0, 8)
      .map(({ event }) => event);
  }, [query, eventIndex]);

  // Charger les recherches recentes a l'ouverture
  useEffect(() => {
    if (searchOpen) {
      setRecentSearches(getRecentSearches());
      setQuery("");
      setChips(EMPTY_CHIPS);
      setPanel(null);
      setPreviousState(null);
      setExpanded(new Set());
    }
  }, [searchOpen]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
  }, []);

  // Une seule porte vers le moteur : texte + pastilles, apres une courte
  // pause. Une requete en erreur ou vide ne part pas (useSearch la vide).
  useEffect(() => {
    if (!searchOpen) return;
    setSearchQuery(effectiveQuery);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(effectiveQuery);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [effectiveQuery, searchOpen, search, setSearchQuery]);

  // Expediteurs proposes : carnet de contacts, les plus echanges d'abord.
  useEffect(() => {
    if (panel !== "from") return;
    const userId = getCurrentUserId();
    if (!userId) return;
    const q = fromInput.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    let cancelled = false;
    const timer = setTimeout(
      () => {
        contactsCollection()
          .getList<Contact>(1, 8, {
            filter: q
              ? `user = "${userId}" && (name ~ "${q}" || email ~ "${q}")`
              : `user = "${userId}"`,
            sort: "-message_count",
            skipTotal: true,
          })
          .then((res) => {
            if (!cancelled) setFromOptions(res.items);
          })
          .catch(() => {
            if (!cancelled) setFromOptions([]);
          });
      },
      q ? 200 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [panel, fromInput]);

  const togglePanel = useCallback(
    (next: "from" | "date") => {
      setPanel((cur) => (cur === next ? null : next));
      if (next === "from") setFromInput("");
      if (next === "date") {
        setDraftAfter(chips.after);
        setDraftBefore(chips.before);
      }
    },
    [chips.after, chips.before]
  );

  const chooseFrom = useCallback((value: string) => {
    const v = value.trim();
    if (!v) return;
    setChips((c) => ({ ...c, from: v }));
    setPanel(null);
  }, []);

  const applyDates = useCallback((after: string, before: string) => {
    setChips((c) => ({ ...c, after, before }));
    setPanel(null);
  }, []);

  const dateLabel = useMemo(() => {
    if (!chips.after && !chips.before) return t("search.filter.date");
    if (!chips.before) {
      const preset = DATE_PRESETS.find((p) => presetAfter(p.days) === chips.after);
      if (preset) return t(`search.filter.${preset.key}`);
      return t("search.filter.since", { date: formatDay(chips.after, locale) });
    }
    if (!chips.after) return t("search.filter.until", { date: formatDay(chips.before, locale) });
    return `${formatDay(chips.after, locale)} – ${formatDay(chips.before, locale)}`;
  }, [chips.after, chips.before, locale, t]);

  const draftOrderError = !!draftAfter && !!draftBefore && draftAfter > draftBefore;
  const dateHasError = queryErrors.some((e) => e.code === "invalidDate" || e.code === "dateOrder");

  const handleSelectMessage = useCallback(
    (message: MessageWithFolder) => {
      if (hasQuery) {
        saveRecentSearch(effectiveQuery);
      }
      const threadId = message.thread_id ?? message.message_id;
      // Verrouiller la selection AVANT de naviguer : sinon setActiveFolder
      // (declenche par le changement de dossier) efface la selection non
      // verrouillee, et comme le mail matche est souvent hors de la 1ere page
      // (envoyes/spam = mails plus anciens), l'effet d'auto-selection ne le
      // re-selectionne pas -> on ne voit que la liste du dossier. Le verrou
      // preserve la selection le temps que ThreadView charge le thread depuis PB.
      lockSelection();
      selectMessage(message.id, threadId, true);
      const folderType = message.expand?.folder?.type ?? "inbox";
      const params = new URLSearchParams();
      // Conserver la recherche active dans l'URL : sans `q`, la liste de fond
      // se rechargeait sur le dossier ENTIER (perte du contexte de recherche,
      // percu comme "ca rafraichit la liste au lieu d'ouvrir le mail").
      if (hasQuery) params.set("q", effectiveQuery);
      if (threadId) params.set("t", threadId);
      params.set("m", message.id);
      navigate(`/mail/${folderType}?${params.toString()}`);
      closeSearch();
    },
    [hasQuery, effectiveQuery, selectMessage, lockSelection, closeSearch, navigate]
  );

  const handleSelectEvent = useCallback(
    (event: CalendarEvent) => {
      if (hasQuery) saveRecentSearch(effectiveQuery);
      navigate(`/calendar?event=${event.id}`);
      closeSearch();
    },
    [hasQuery, effectiveQuery, navigate, closeSearch]
  );

  // Toucher un contact = filtrer sur lui (pastille Expediteur), retour possible.
  const handleSelectContact = useCallback(
    (email: string) => {
      setPreviousState({ query, chips });
      setChips((c) => ({ ...c, from: email }));
      setQuery("");
    },
    [query, chips]
  );

  const handleBack = useCallback(() => {
    if (previousState !== null) {
      setQuery(previousState.query);
      setChips(previousState.chips);
      setPreviousState(null);
    }
  }, [previousState]);

  const handleComposeToContact = useCallback(
    (email: string, e: React.MouseEvent) => {
      e.stopPropagation();
      openCompose("new", null, email);
      closeSearch();
    },
    [openCompose, closeSearch]
  );

  // Une recherche recente (texte, ancien format compris) retrouve ses pastilles.
  const handleRecentSearch = useCallback((term: string) => {
    const split = splitChipsFromQuery(term);
    setChips(split.chips);
    setQuery(split.text);
  }, []);

  const handleOpenInMain = useCallback(
    (folderType: string) => {
      if (hasQuery && queryErrors.length === 0) {
        saveRecentSearch(effectiveQuery);
        navigate(`/mail/${folderType}?q=${encodeURIComponent(effectiveQuery)}`);
        closeSearch();
      }
    },
    [hasQuery, queryErrors.length, effectiveQuery, navigate, closeSearch]
  );

  // Grouper les contacts (uniquement ceux dont le nom ou email matche la requete)
  const contacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const contactsMap = new Map<
      string,
      { name: string; email: string; count: number }
    >();
    for (const msg of results) {
      const email = msg.from_address?.address ?? "";
      const name = msg.from_address?.name ?? "";
      if (!email) continue;
      // Ne garder que les contacts dont le nom ou l'email contient le terme
      if (!email.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
      const existing = contactsMap.get(email);
      if (existing) {
        existing.count++;
      } else {
        contactsMap.set(email, {
          name: name || email,
          email,
          count: 1,
        });
      }
    }
    return Array.from(contactsMap.values()).slice(0, 5);
  }, [results, query]);

  // Grouper les resultats par dossier
  const folderGroups = useMemo(() => {
    const groups = new Map<
      string,
      { type: string; label: string; messages: MessageWithFolder[] }
    >();

    for (const msg of results) {
      const folderType = msg.expand?.folder?.type ?? "inbox";
      if (!groups.has(folderType)) {
        groups.set(folderType, {
          type: folderType,
          label: t(`folder.${folderType}`),
          messages: [],
        });
      }
      groups.get(folderType)!.messages.push(msg);
    }

    // Trier par ordre defini
    return Array.from(groups.values()).sort((a, b) => {
      const ia = FOLDER_ORDER.indexOf(a.type);
      const ib = FOLDER_ORDER.indexOf(b.type);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [results, t]);

  return (
    <CommandDialog
      data-ref="search"
      open={searchOpen}
      onOpenChange={(open) => !open && closeSearch()}
      title={t("search.title")}
      description={t("search.description")}
      showCloseButton={false}
      shouldFilter={false}
      className={cn(
        // Mobile : ECRAN ENTIER (champ en haut, resultats dessous qui defilent)
        // a la hauteur reelle de l'app (--app-height, cf. globals.css) ; le
        // champ passe sous le flou de la status bar via var(--app-top)
        // (PWA iPhone) et la liste se termine au-dessus du clavier
        // (--keyboard-inset). Desktop (sm+) : palette flottante d'origine.
        "fullscreen-mobile inset-0 top-0 left-0 flex h-[var(--app-height,100dvh)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 pt-[var(--app-top)] shadow-none",
        "data-[state=open]:slide-in-from-top-2 data-[state=closed]:slide-out-to-top-2 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100",
        "sm:inset-auto sm:top-8 sm:left-[50%] sm:grid sm:h-auto sm:max-w-lg sm:translate-x-[-50%] sm:rounded-3xl sm:border sm:pt-0 sm:shadow-xl sm:transition-[max-width] sm:duration-200 sm:ease-out",
        hasQuery && results.length > 0 && "sm:max-w-2xl"
      )}
    >
      <div className="relative shrink-0 border-b">
        <div className="flex items-center gap-2 px-3 pt-2 pb-2 sm:pt-3">
          {previousState !== null && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent"
              onClick={handleBack}
              title={t("search.back")}
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          {/* Champ en pilule grise du kit (SearchField) : loupe, texte, croix.
              Garde l'entree cmdk pour la navigation clavier de la palette. */}
          <div
            data-ref="search-field"
            className="bg-muted text-muted-foreground flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full px-4"
          >
            <Search className="size-[1.15rem] shrink-0" />
            <CommandPrimitive.Input
              data-ref="search-input"
              placeholder={t("search.placeholder")}
              value={query}
              onValueChange={handleQueryChange}
              className="text-foreground placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-hidden"
            />
            {loading && (
              <Loader2
                data-ref="search-loader"
                className="size-4 shrink-0 animate-spin"
                aria-label={t("search.searching")}
              />
            )}
            {query && (
              <button
                type="button"
                data-ref="search-clear"
                onMouseDown={keepInputFocus}
                onClick={() => setQuery("")}
                className="text-muted-foreground hover:text-foreground -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full"
                aria-label={t("search.clear")}
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {/* Mobile : l'ecran entier n'a plus de fond a toucher pour fermer. */}
          <button
            type="button"
            data-ref="search-cancel"
            className="text-primary shrink-0 px-1 text-sm font-medium sm:hidden"
            onClick={closeSearch}
          >
            {t("search.cancel")}
          </button>
        </div>

        {/* Pastilles de filtres : chacune pose un operateur verifie dans la
            requete ; active = pleine, avec une croix pour la retirer. */}
        <ChipRow data-ref="search-chips" aria-label={t("search.filters")} className="px-3 pb-2.5">
          {(
            [
              ["unread", "search.filter.unread"],
              ["starred", "search.filter.starred"],
              ["attachment", "search.filter.attachment"],
            ] as const
          ).map(([key, label]) => (
            <Chip
              key={key}
              data-ref={`search-chip-${key}`}
              active={chips[key]}
              onMouseDown={keepInputFocus}
              onClick={() => setChips((c) => ({ ...c, [key]: !c[key] }))}
            >
              {t(label)}
              {chips[key] && <X className="-mr-1 size-3.5 opacity-80" aria-hidden="true" />}
            </Chip>
          ))}
          <Chip
            data-ref="search-chip-from"
            active={!!chips.from}
            chevron={!chips.from}
            onMouseDown={keepInputFocus}
            onClick={() => togglePanel("from")}
            className="max-w-[14rem]"
          >
            <span className="truncate">{chips.from || t("search.filter.from")}</span>
            {chips.from && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={t("search.filter.remove")}
                className="-mr-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  setChips((c) => ({ ...c, from: null }));
                  setPanel(null);
                }}
              >
                <X className="size-3.5 opacity-80" />
              </span>
            )}
          </Chip>
          <Chip
            data-ref="search-chip-date"
            active={!!(chips.after || chips.before)}
            chevron={!(chips.after || chips.before)}
            onMouseDown={keepInputFocus}
            onClick={() => togglePanel("date")}
            className={cn(dateHasError && "border-destructive text-destructive")}
          >
            {dateLabel}
            {(chips.after || chips.before) && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={t("search.filter.remove")}
                className="-mr-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  setChips((c) => ({ ...c, after: "", before: "" }));
                  setPanel(null);
                }}
              >
                <X className="size-3.5 opacity-80" />
              </span>
            )}
          </Chip>
        </ChipRow>

        {/* Sous-panneaux : leurs touches ne doivent pas piloter la liste cmdk. */}
        {panel === "from" && (
          <div
            data-ref="search-from-panel"
            className="border-t px-3 py-2.5"
            onKeyDown={(e) => {
              if (e.key === "Escape") return;
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                chooseFrom(fromOptions[0]?.email || fromInput);
              }
            }}
          >
            <SearchField
              value={fromInput}
              onValueChange={setFromInput}
              placeholder={t("search.filter.fromPlaceholder")}
              autoFocus
              className="h-10"
            />
            <div className="mt-1.5 max-h-56 overflow-y-auto overscroll-contain">
              {fromInput.trim() && (
                <button
                  type="button"
                  data-ref="search-from-use"
                  onClick={() => chooseFrom(fromInput)}
                  className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                >
                  <User className="text-muted-foreground size-4 shrink-0" />
                  <span className="text-muted-foreground shrink-0">{t("search.filter.useAddress")}</span>
                  <span className="min-w-0 truncate font-medium">{fromInput.trim()}</span>
                </button>
              )}
              {fromOptions.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => chooseFrom(c.email)}
                  className="hover:bg-accent flex w-full min-w-0 flex-col rounded-lg px-2 py-1.5 text-left"
                >
                  <span className="truncate text-sm font-medium">{c.name || c.email}</span>
                  {c.name && <span className="text-muted-foreground truncate text-xs">{c.email}</span>}
                </button>
              ))}
              {!fromInput.trim() && fromOptions.length === 0 && (
                <p className="text-muted-foreground px-2 py-2 text-sm">{t("search.filter.noContacts")}</p>
              )}
            </div>
          </div>
        )}
        {panel === "date" && (
          <div
            data-ref="search-date-panel"
            className="space-y-3 border-t px-3 py-3"
            onKeyDown={(e) => {
              if (e.key !== "Escape") e.stopPropagation();
            }}
          >
            <ChipRow>
              {DATE_PRESETS.map((p) => {
                const after = presetAfter(p.days);
                return (
                  <Chip
                    key={p.key}
                    active={chips.after === after && !chips.before}
                    onClick={() => applyDates(after, "")}
                  >
                    {t(`search.filter.${p.key}`)}
                  </Chip>
                );
              })}
            </ChipRow>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-muted-foreground flex min-w-0 flex-col gap-1 text-xs">
                {t("search.filter.dateFrom")}
                <input
                  type="date"
                  data-ref="search-date-after"
                  value={draftAfter}
                  onChange={(e) => setDraftAfter(normalizeSearchDate(e.target.value) ?? "")}
                  className={cn(
                    "bg-muted text-foreground h-10 w-full min-w-0 rounded-xl px-3 text-sm outline-hidden",
                    draftOrderError && "ring-destructive ring-1"
                  )}
                />
              </label>
              <label className="text-muted-foreground flex min-w-0 flex-col gap-1 text-xs">
                {t("search.filter.dateTo")}
                <input
                  type="date"
                  data-ref="search-date-before"
                  value={draftBefore}
                  onChange={(e) => setDraftBefore(normalizeSearchDate(e.target.value) ?? "")}
                  className={cn(
                    "bg-muted text-foreground h-10 w-full min-w-0 rounded-xl px-3 text-sm outline-hidden",
                    draftOrderError && "ring-destructive ring-1"
                  )}
                />
              </label>
            </div>
            <div className="flex items-center justify-end gap-3">
              {draftOrderError && (
                <p className="text-destructive min-w-0 flex-1 text-xs">{t("search.error.dateOrder")}</p>
              )}
              <Button
                type="button"
                size="sm"
                data-ref="search-date-apply"
                className="rounded-full"
                disabled={(!draftAfter && !draftBefore) || draftOrderError}
                onClick={() => applyDates(draftAfter, draftBefore)}
              >
                {t("search.filter.apply")}
              </Button>
            </div>
          </div>
        )}

        {loading && (
          <span
            aria-hidden="true"
            className="absolute -bottom-px left-0 h-px w-full overflow-hidden"
          >
            <span
              className="bg-primary block h-full w-1/3"
              style={{ animation: "search-progress 1.1s ease-in-out infinite" }}
            />
          </span>
        )}
      </div>
      <CommandList className="max-h-none min-h-0 flex-1 overscroll-contain pb-[calc(var(--keyboard-inset,0px)+env(safe-area-inset-bottom,0px))] sm:max-h-[min(60vh,500px)] sm:flex-none sm:pb-0">
        {queryErrors.length === 0 && (
          <CommandEmpty>
            {loading ? t("search.searching") : hasQuery ? t("search.noResults") : null}
          </CommandEmpty>
        )}

        {/* Requete mal formee : on le dit, on ne cherche pas (jamais un
            filtre ignore en silence). */}
        {queryErrors.length > 0 && (
          <div data-ref="search-errors" role="alert" className="text-destructive px-4 py-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4 shrink-0" />
              {t("search.error.title")}
            </p>
            <ul className="mt-1.5 space-y-1 pl-6">
              {queryErrors.map((err, i) => (
                <li key={`${err.code}-${i}`} className="min-w-0 break-words">
                  <code className="bg-destructive/10 rounded px-1 py-0.5 text-xs">{err.token}</code>{" "}
                  {t(`search.error.${err.code}`)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recherches recentes */}
        {!hasQuery && recentSearches.length > 0 && (
          <CommandGroup data-ref="search-recent" heading={t("search.recent")}>
            {recentSearches.map((term) => (
              <CommandItem
                key={term}
                value={`recent-${term}`}
                onSelect={() => handleRecentSearch(term)}
              >
                <Clock className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{term}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Astuces de recherche */}
        {/* Astuces : deux colonnes fixes (libelle | exemple), alignees d'une
            ligne a l'autre, jamais de retour a la ligne. */}
        {!hasQuery && (
          <CommandGroup data-ref="search-tips" heading={t("search.tips")}>
            {SEARCH_TIPS.map((tip) => (
              <CommandItem
                key={tip.key}
                value={`tip-${tip.key}`}
                onSelect={() => handleQueryChange(tip.example)}
              >
                <Info className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t(`search.tip.${tip.key}`)}</span>
                <span className="w-[52%] max-w-60 min-w-0 shrink-0">
                  <code className="bg-muted text-muted-foreground inline-block max-w-full truncate rounded px-1.5 py-0.5 align-middle text-xs">
                    {tip.example}
                  </code>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Premiere construction de l'index apres une mise en ligne : la
            recherche repond deja, sur les mails les plus recents d'abord. */}
        {hasQuery && queryErrors.length === 0 && indexing && (
          <div
            data-ref="search-indexing"
            className="text-muted-foreground flex items-center gap-2 px-4 py-2 text-xs"
          >
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span>
              {t("search.indexing")}
              {indexing.total > 0
                ? ` (${Math.min(100, Math.floor((indexing.done / indexing.total) * 100))} %)`
                : ""}
            </span>
          </div>
        )}

        {/* Resultats compacts : un en-tete par theme, depliable a la demande */}
        {hasQuery &&
          queryErrors.length === 0 &&
          (contacts.length > 0 ||
            eventResults.length > 0 ||
            folderGroups.length > 0) && (
            <CommandGroup data-ref="search-sections">
              {/* Contacts */}
              {contacts.length > 0 && (
                <>
                  <CommandItem
                    data-ref="search-section-contacts"
                    value="section-contacts"
                    onSelect={() => toggleSection("contacts")}
                  >
                    <ChevronRight
                      className={cn(
                        "text-muted-foreground size-3.5 shrink-0 transition-transform",
                        expanded.has("contacts") && "rotate-90"
                      )}
                    />
                    <User className="text-muted-foreground size-4 shrink-0" />
                    <span className="flex-1 truncate text-sm font-medium">{t("search.contacts")}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">{contacts.length}</span>
                  </CommandItem>
                  {expanded.has("contacts") &&
                    contacts.map((contact) => (
                      <CommandItem
                        key={contact.email}
                        className="pl-9"
                        onSelect={() => handleSelectContact(contact.email)}
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm">{contact.name}</span>
                          <span className="text-muted-foreground text-xs">
                            {contact.email} &middot; {contact.count}{" "}
                            {contact.count > 1 ? t("search.messagesCount") : t("search.message")}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5 transition-colors hover:bg-accent"
                          title={t("search.composeToContact")}
                          onClick={(e) => handleComposeToContact(contact.email, e)}
                        >
                          <PenLine className="!size-4" />
                        </button>
                      </CommandItem>
                    ))}
                </>
              )}

              {/* Agenda */}
              {eventResults.length > 0 && (
                <>
                  <CommandItem
                    data-ref="search-section-events"
                    value="section-events"
                    onSelect={() => toggleSection("events")}
                  >
                    <ChevronRight
                      className={cn(
                        "text-muted-foreground size-3.5 shrink-0 transition-transform",
                        expanded.has("events") && "rotate-90"
                      )}
                    />
                    <CalendarDays className="text-muted-foreground size-4 shrink-0" />
                    <span className="flex-1 truncate text-sm font-medium">{t("search.events")}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">{eventResults.length}</span>
                  </CommandItem>
                  {expanded.has("events") &&
                    eventResults.map((event) => (
                      <CommandItem key={event.id} className="pl-9" onSelect={() => handleSelectEvent(event)}>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium">
                            {event.title || t("calendar.untitled")}
                          </span>
                          <span className="text-muted-foreground truncate text-xs">
                            {formatEventDate(event, locale)}
                            {event.location ? ` · ${event.location}` : ""}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                </>
              )}

              {/* Messages groupes par dossier */}
              {folderGroups.map((group) => {
                const Icon = FOLDER_ICONS[group.type] ?? MessageSquare;
                const isOpen = expanded.has(group.type);
                return (
                  <div key={group.type}>
                    <CommandItem
                      data-ref={`search-section-${group.type}`}
                      value={`section-${group.type}`}
                      onSelect={() => toggleSection(group.type)}
                    >
                      <ChevronRight
                        className={cn(
                          "text-muted-foreground size-3.5 shrink-0 transition-transform",
                          isOpen && "rotate-90"
                        )}
                      />
                      <Icon className="text-muted-foreground size-4 shrink-0" />
                      <span className="flex-1 truncate text-sm font-medium">{group.label}</span>
                      {isOpen && (
                        <button
                          type="button"
                          className="bg-foreground text-background inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80"
                          title={t("search.openInMain")}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenInMain(group.type);
                          }}
                        >
                          {t("search.seeAll")}
                          <ArrowUpRight className="size-3" />
                        </button>
                      )}
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {/* Total EXACT du dossier (la palette n'en charge que les plus recents). */}
                        {Math.max(counts?.[group.type] ?? 0, group.messages.length)}
                      </span>
                    </CommandItem>
                    {isOpen &&
                      group.messages.map((message) => (
                        <CommandItem
                          key={message.id}
                          className="pl-9"
                          onSelect={() => handleSelectMessage(message)}
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {stripReplacementChars(message.from_address?.name || message.from_address?.address || "")}
                              </span>
                              <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1 text-xs">
                                {message.has_attachments && <Paperclip className="size-3.5" />}
                                {formatRelativeDate(message.date)}
                              </span>
                            </div>
                            <span className="truncate text-sm">
                              {stripReplacementChars(message.subject) || t("message.noSubject")}
                            </span>
                            {message.snippet && (
                              <span className="text-muted-foreground truncate text-xs">
                                {stripReplacementChars(message.snippet)}
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                  </div>
                );
              })}
            </CommandGroup>
          )}
      </CommandList>
    </CommandDialog>
  );
}
