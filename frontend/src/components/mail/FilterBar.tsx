"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMailStore } from "@/lib/stores/mail-store";
import { useT } from "@/lib/i18n";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  CheckSquare,
  Flag,
  Paperclip,
  RefreshCw,
  Rows2,
  Settings2,
  Rows3,
  Rows4,
  Search,
  SlidersHorizontal,
  Star,
  Tag,
  X,
} from "lucide-react";
import { Chip, ChipIconButton, ChipRow } from "@/components/ui/kit";
import { Drawer, DrawerContent, DrawerSheetHeader } from "@/components/ui/drawer";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useLabels } from "@/lib/hooks/useLabels";
import { useLabelCounts, type LabelCount } from "@/lib/hooks/useLabelCounts";
import { hashNavigate } from "@/lib/hash-router";
import { useContacts } from "@/lib/hooks/useContacts";
import { setDensity, useSettings, type Density } from "@/lib/hooks/useSettings";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { cn } from "@/lib/utils";
import type { ListFilter } from "@/lib/stores/mail-store";
import { useImportanceCountsFetcher } from "@/lib/hooks/useImportanceCounts";
import { IMPORTANCE_COLORS, IMPORTANCE_LEVELS } from "@/lib/importance";
import type { Contact } from "@/lib/pocketbase";

const DEBOUNCE_MS = 300;
const NEXT_DENSITY: Record<Density, Density> = {
  compact: "comfortable",
  comfortable: "spacious",
  spacious: "compact",
};

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function ContactFilterInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const { searchContacts } = useContacts();
  const [inputValue, setInputValue] = useState(value);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!value && inputValue) setInputValue("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setInputValue(val);
    onChange(val);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (val.trim().length >= 1) {
      debounceRef.current = setTimeout(async () => {
        const results = await searchContacts(val.trim());
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
        setHighlightedIndex(-1);
      }, 200);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }

  function selectContact(contact: Contact) {
    const display = contact.name || contact.email;
    setInputValue(display);
    onChange(display);
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Enter" && highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
      e.preventDefault();
      selectContact(suggestions[highlightedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  }

  return (
    <Popover open={showSuggestions} onOpenChange={setShowSuggestions}>
      <PopoverAnchor asChild>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder={placeholder}
          className="h-10 min-w-0 flex-1 rounded-full bg-muted px-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/40"
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-[260px] p-1.5"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="max-h-48 overflow-y-auto">
          {suggestions.map((contact, index) => (
            <button
              key={contact.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectContact(contact)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                index === highlightedIndex && "bg-accent text-accent-foreground"
              )}
            >
              <ContactAvatar
                name={contact.name}
                email={contact.email}
                className="size-7 shrink-0"
                textClassName="text-[10px]"
              />
              <div className="min-w-0 flex-1 text-left">
                {contact.name && (
                  <div className="truncate text-xs">{contact.name}</div>
                )}
                <div className="truncate text-[10px] text-muted-foreground">{contact.email}</div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Une ligne du panneau "reglages" : picto, libelle, coche a droite. */
function SettingRow({
  icon: Icon,
  label,
  checked,
  trailing,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  checked?: boolean;
  trailing?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent active:bg-accent"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {checked && <Check className="size-4 shrink-0" />}
    </button>
  );
}

/** Nombres d'une etiquette (non lus / total), comme dans l'ancien menu de gauche. */
function LabelCountText({ count }: { count: LabelCount | undefined }) {
  if (!count || count.total <= 0) return null;
  return (
    <span data-ref="filter-label-count" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
      {count.unread > 0 && <span className="font-semibold text-foreground">{count.unread}</span>}
      {count.unread > 0 && " / "}
      {count.total}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{children}</div>
  );
}

/**
 * Rangee de filtres de la liste (charte des maquettes) : pastilles Tous / Non
 * lus / Personnes / Etiquettes, puis au bout un bouton "reglages" qui regroupe
 * les autres filtres (pieces jointes, favoris, priorite, texte), la densite,
 * la selection et l'actualisation. Le bouton se marque quand un reglage non
 * visible dans la rangee est actif.
 */
export function FilterBar({
  allItemIds,
  activeLabelId = null,
  onRefresh,
  trailing,
}: {
  allItemIds: string[];
  /** Etiquette affichee (route #/mail/label/:id), pour marquer la pastille. */
  activeLabelId?: string | null;
  onRefresh?: () => void;
  /** Bouton pose au bout de la rangee, avant les reglages (ex. "Reanalyser le
   * spam" sur ordinateur). */
  trailing?: ReactNode;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const { density } = useSettings();
  const { list: labelList } = useLabels();
  // Le filtre "Etiquettes" reprend ce qu'offrait le menu de gauche (nombres +
  // "Gerer les etiquettes") : en apparence Miel, c'est sa seule entree.
  const labelCounts = useLabelCounts();
  const listFilter = useMailStore((s) => s.listFilter);
  const setListFilter = useMailStore((s) => s.setListFilter);
  const clearListFilter = useMailStore((s) => s.clearListFilter);
  const checkedIds = useMailStore((s) => s.checkedIds);
  const checkAll = useMailStore((s) => s.checkAll);
  const uncheckAll = useMailStore((s) => s.uncheckAll);
  const checkedCount = checkedIds.size;
  const allChecked = checkedCount > 0 && allItemIds.length > 0 && checkedCount === allItemIds.length;

  const [fromLocal, setFromLocal] = useState(listFilter.fromText);
  const [bodyLocal, setBodyLocal] = useState(listFilter.bodyText);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fromDebounced = useDebounced(fromLocal, DEBOUNCE_MS);
  const bodyDebounced = useDebounced(bodyLocal, DEBOUNCE_MS);

  const prevFromRef = useRef(fromDebounced);
  const prevBodyRef = useRef(bodyDebounced);

  useEffect(() => {
    if (fromDebounced !== prevFromRef.current) {
      prevFromRef.current = fromDebounced;
      setListFilter({ fromText: fromDebounced });
    }
  }, [fromDebounced, setListFilter]);

  useEffect(() => {
    if (bodyDebounced !== prevBodyRef.current) {
      prevBodyRef.current = bodyDebounced;
      setListFilter({ bodyText: bodyDebounced });
    }
  }, [bodyDebounced, setListFilter]);

  // Filtres remis a zero par la page (changement de dossier) : on suit.
  useEffect(() => {
    if (!listFilter.bodyText && bodyLocal) setBodyLocal("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFilter.bodyText]);
  useEffect(() => {
    if (!listFilter.fromText && fromLocal) setFromLocal("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFilter.fromText]);

  const handleClear = useCallback(() => {
    setFromLocal("");
    setBodyLocal("");
    clearListFilter();
  }, [clearListFilter]);

  const clearPeople = useCallback(() => {
    setFromLocal("");
    setListFilter({ fromText: "" });
  }, [setListFilter]);

  // "Tous" : retire les filtres de la rangee (non lus, personne) ; depuis une
  // etiquette, revient a la boite de reception.
  const handleAll = useCallback(() => {
    setFromLocal("");
    setListFilter({ unread: false, fromText: "", importance: null });
    if (activeLabelId) hashNavigate("/mail/inbox");
  }, [setListFilter, activeLabelId]);

  // Reglages caches derriere le bouton : pieces jointes, favoris, priorite, texte.
  const hiddenActive =
    listFilter.hasAttachments ||
    listFilter.starred ||
    listFilter.priority !== "all" ||
    !!listFilter.bodyText.trim();
  const anyActive =
    hiddenActive || listFilter.unread || !!listFilter.fromText.trim() || !!listFilter.importance;
  const allActive =
    !listFilter.unread && !listFilter.fromText.trim() && !activeLabelId && !listFilter.importance;
  // Pastilles de niveau (tri en trois niveaux) : non lus par niveau du contexte.
  const importanceCounts = useImportanceCountsFetcher();
  const showImportance = importanceCounts !== null || !!listFilter.importance;
  const activeLabel = activeLabelId ? labelList.find((l) => l.id === activeLabelId) : undefined;

  const densityOptions: { key: Density; label: string; Icon: typeof Rows2 }[] = [
    { key: "compact", label: t("mailList.viewMode.compact"), Icon: Rows4 },
    { key: "comfortable", label: t("mailList.viewMode.medium"), Icon: Rows3 },
    { key: "spacious", label: t("mailList.viewMode.large"), Icon: Rows2 },
  ];
  const priorityOptions: { key: ListFilter["priority"]; label: string }[] = [
    { key: "high", label: t("filter.priorityHigh") },
    { key: "normal", label: t("filter.priorityNormal") },
    { key: "low", label: t("filter.priorityLow") },
  ];

  const settingsPanel = (
    <div className="flex flex-col" data-ref="filter-settings-panel">
      <SectionLabel>{t("filter.title")}</SectionLabel>
      <SettingRow
        icon={Paperclip}
        label={t("filter.attachments")}
        checked={listFilter.hasAttachments}
        onSelect={() => setListFilter({ hasAttachments: !listFilter.hasAttachments })}
      />
      <SettingRow
        icon={Star}
        label={t("filter.starred")}
        checked={listFilter.starred}
        onSelect={() => setListFilter({ starred: !listFilter.starred })}
      />
      {priorityOptions.map((p) => (
        <SettingRow
          key={p.key}
          icon={Flag}
          label={`${t("filter.priority")} : ${p.label}`}
          checked={listFilter.priority === p.key}
          onSelect={() =>
            setListFilter({ priority: listFilter.priority === p.key ? "all" : p.key })
          }
        />
      ))}
      <div className="px-1.5 py-1.5">
        <label className="flex h-10 items-center gap-2.5 rounded-full bg-muted px-3.5 text-sm">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={bodyLocal}
            onChange={(e) => setBodyLocal(e.target.value)}
            placeholder={t("filter.text")}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {bodyLocal && (
            <button
              type="button"
              onClick={() => setBodyLocal("")}
              aria-label={t("filter.clear")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </label>
      </div>
      <div className="my-1 h-px bg-border" aria-hidden />
      <SectionLabel>{t("mailList.viewMode")}</SectionLabel>
      {densityOptions.map((d) => (
        <SettingRow
          key={d.key}
          icon={d.Icon}
          label={d.label}
          checked={density === d.key}
          onSelect={() => setDensity(d.key)}
        />
      ))}
      <div className="my-1 h-px bg-border" aria-hidden />
      <SettingRow
        icon={CheckSquare}
        label={allChecked ? t("bulk.deselectAll") : t("bulk.selectAll")}
        onSelect={() => {
          if (allChecked) uncheckAll();
          else checkAll(allItemIds);
          setSettingsOpen(false);
        }}
      />
      {onRefresh && (
        <SettingRow
          icon={RefreshCw}
          label={t("mail.refresh")}
          onSelect={() => {
            setSettingsOpen(false);
            onRefresh();
          }}
        />
      )}
      {anyActive && (
        <SettingRow
          icon={X}
          label={t("filter.clear")}
          onSelect={() => {
            handleClear();
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );

  const settingsButton = (
    <ChipIconButton
      marked={hiddenActive}
      aria-label={t("filter.title")}
      title={t("filter.title")}
      data-ref="filter-settings"
      onClick={isMobile ? () => setSettingsOpen(true) : undefined}
    >
      <SlidersHorizontal />
    </ChipIconButton>
  );

  const labelRows = labelList.map((l) => (
    <SettingRow
      key={l.id}
      icon={Tag}
      label={l.name}
      checked={l.id === activeLabelId}
      trailing={<LabelCountText count={labelCounts.get(l.id)} />}
      onSelect={() => {
        setLabelsOpen(false);
        hashNavigate(`/mail/label/${l.id}`);
      }}
    />
  ));
  const manageLabels = () => {
    setLabelsOpen(false);
    hashNavigate("/settings?tab=labels");
  };

  return (
    <div className="flex items-center gap-2 px-[10px] pb-2.5 md:px-4 md:pt-3" data-ref="filter-bar">
      <ChipRow className="min-w-0 flex-1">
        <Chip active={allActive} onClick={handleAll} data-ref="filter-chip-all">
          {t("filter.all")}
        </Chip>
        {showImportance &&
          IMPORTANCE_LEVELS.map((lvl) => {
            const active = listFilter.importance === lvl;
            return (
              <Chip
                key={lvl}
                active={active}
                count={importanceCounts ? importanceCounts[lvl] : null}
                onClick={() => setListFilter({ importance: active ? null : lvl })}
                data-ref={`filter-chip-importance-${lvl}`}
                title={t(`importance.hint.${lvl}`)}
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full ring-1 ring-background/60"
                  style={{ backgroundColor: IMPORTANCE_COLORS[lvl] }}
                />
                {t(`importance.chip.${lvl}`)}
              </Chip>
            );
          })}
        <Chip
          active={listFilter.unread}
          onClick={() => setListFilter({ unread: !listFilter.unread })}
          data-ref="filter-chip-unread"
        >
          {t("filter.unread")}
        </Chip>

        {/* Personnes : filtre par expediteur (choix d'un contact) */}
        <Popover open={peopleOpen} onOpenChange={setPeopleOpen}>
          <PopoverTrigger asChild>
            <Chip
              active={!!listFilter.fromText.trim()}
              chevron={!listFilter.fromText.trim()}
              data-ref="filter-chip-people"
            >
              <span className="max-w-[9rem] truncate">
                {listFilter.fromText.trim() || t("filter.people")}
              </span>
              {!!listFilter.fromText.trim() && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t("filter.clear")}
                  onClick={(e) => {
                    e.stopPropagation();
                    clearPeople();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      clearPeople();
                    }
                  }}
                  className="-mr-1.5 inline-flex size-5 items-center justify-center rounded-full hover:bg-primary-foreground/20"
                >
                  <X className="size-3.5" />
                </span>
              )}
            </Chip>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-2.5">
            <div className="flex items-center gap-2">
              <ContactFilterInput
                value={listFilter.fromText}
                onChange={setFromLocal}
                placeholder={t("filter.from")}
              />
            </div>
          </PopoverContent>
        </Popover>

        {/* Etiquettes : ouvre la liste filtree par etiquette */}
        {isMobile ? (
          <Chip
            active={!!activeLabelId}
            chevron
            onClick={() => setLabelsOpen(true)}
            data-ref="filter-chip-labels"
          >
            <span className="max-w-[9rem] truncate">{activeLabel?.name || t("filter.labels")}</span>
          </Chip>
        ) : (
          <DropdownMenu open={labelsOpen} onOpenChange={setLabelsOpen}>
            <DropdownMenuTrigger asChild>
              <Chip active={!!activeLabelId} chevron data-ref="filter-chip-labels">
                <span className="max-w-[9rem] truncate">{activeLabel?.name || t("filter.labels")}</span>
              </Chip>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-60">
              {labelList.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">{t("filter.noLabels")}</div>
              ) : (
                labelList.map((l) => (
                  <DropdownMenuItem
                    key={l.id}
                    onSelect={() => hashNavigate(`/mail/label/${l.id}`)}
                    className="gap-2.5"
                  >
                    <Tag className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    <LabelCountText count={labelCounts.get(l.id)} />
                    {l.id === activeLabelId && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={manageLabels} className="gap-2.5" data-ref="filter-labels-manage">
                <Settings2 className="size-4" />
                <span>{t("settings.manageLabels")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ChipRow>

      {trailing}

      {/* Reglages : popover sur ordinateur, feuille du bas sur telephone */}
      {isMobile ? (
        settingsButton
      ) : (
        <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
          <PopoverTrigger asChild>{settingsButton}</PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1.5">
            {settingsPanel}
          </PopoverContent>
        </Popover>
      )}

      {isMobile && (
        <>
          <Drawer open={settingsOpen} onOpenChange={setSettingsOpen} repositionInputs={false} noBodyStyles>
            <DrawerContent hideGrip className="sheet-max-h" data-ref="filter-settings-sheet">
              <DrawerSheetHeader
                title={t("filter.title")}
              />
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {settingsPanel}
              </div>
            </DrawerContent>
          </Drawer>
          <Drawer open={labelsOpen} onOpenChange={setLabelsOpen} repositionInputs={false} noBodyStyles>
            <DrawerContent hideGrip className="sheet-max-h" data-ref="filter-labels-sheet">
              <DrawerSheetHeader
                title={t("filter.labels")}
              />
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {labelRows.length > 0 ? (
                  labelRows
                ) : (
                  <div className="px-3 py-3 text-sm text-muted-foreground">{t("filter.noLabels")}</div>
                )}
                <SettingRow icon={Settings2} label={t("settings.manageLabels")} onSelect={manageLabels} />
              </div>
            </DrawerContent>
          </Drawer>
        </>
      )}
    </div>
  );
}
