"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { getInitials, getAvatarColor } from "@/lib/utils/avatar";
import { useContacts } from "@/lib/hooks/useContacts";
import { setRecipientSuggestionsOpen } from "@/lib/recipient-suggestions-state";
import type { Contact } from "@/lib/pocketbase";

interface ParsedRecipient {
  name?: string;
  address: string;
}

function parseRecipients(value: string): ParsedRecipient[] {
  if (!value.trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ address: s }));
}

function formatRecipients(recipients: ParsedRecipient[]): string {
  return recipients.map((r) => r.address).join(", ");
}

interface RecipientInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  "data-ref"?: string;
  /**
   * Nom affiche par adresse (cle en minuscules), pour les destinataires
   * pre-remplis d'une reponse : l'etiquette montre le nom, la valeur envoyee
   * reste l'adresse seule.
   */
  names?: Record<string, string>;
}

export function RecipientInput({
  value,
  onChange,
  placeholder,
  className,
  "data-ref": dataRef,
  names,
}: RecipientInputProps) {
  const t = useT();
  const { searchContacts } = useContacts();
  const [recipients, setRecipients] = useState<ParsedRecipient[]>(() => parseRecipients(value));
  // Liste reduite par defaut : quand il y a plusieurs destinataires, on n'affiche
  // que le premier + un compteur "+N" (tap pour developper). Evite qu'une longue
  // liste de destinataires occupe tout l'ecran (surtout en mobile).
  const [expanded, setExpanded] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const isInternalUpdate = useRef(false);
  const labelOf = (r: ParsedRecipient) =>
    r.name || names?.[r.address.toLowerCase()] || r.address;

  // Signale l'etat des suggestions au Drawer de composition mobile (fenetre de
  // grace) : un tap qui ferme la liste ne doit pas fermer le brouillon.
  useEffect(() => {
    if (!showSuggestions) return;
    setRecipientSuggestionsOpen(true);
    return () => setRecipientSuggestionsOpen(false);
  }, [showSuggestions]);

  // Sync from parent value changes (external updates)
  useEffect(() => {
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    setRecipients(parseRecipients(value));
  }, [value]);

  // Sync to parent
  const syncToParent = useCallback(
    (newRecipients: ParsedRecipient[]) => {
      isInternalUpdate.current = true;
      onChange(formatRecipients(newRecipients));
    },
    [onChange]
  );

  function addRecipient(address: string, name?: string) {
    const trimmed = address.trim();
    if (!trimmed) return;
    // Avoid duplicates
    if (recipients.some((r) => r.address.toLowerCase() === trimmed.toLowerCase())) return;
    const newRecipients = [...recipients, { address: trimmed, name }];
    setRecipients(newRecipients);
    syncToParent(newRecipients);
    setInputValue("");
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  }

  function removeRecipient(index: number) {
    const newRecipients = recipients.filter((_, i) => i !== index);
    setRecipients(newRecipients);
    syncToParent(newRecipients);
  }

  function commitInput() {
    const trimmed = inputValue.trim().replace(/,\s*$/, "");
    if (trimmed) {
      // Handle multiple addresses pasted/typed with commas or spaces
      const parts = trimmed.split(/[,;\s]+/).filter(Boolean);
      let newRecipients = [...recipients];
      for (const part of parts) {
        if (!newRecipients.some((r) => r.address.toLowerCase() === part.toLowerCase())) {
          newRecipients = [...newRecipients, { address: part }];
        }
      }
      setRecipients(newRecipients);
      syncToParent(newRecipients);
      setInputValue("");
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
        e.preventDefault();
        const s = suggestions[highlightedIndex];
        addRecipient(s.email, s.name);
        return;
      }
      if (inputValue.trim()) {
        e.preventDefault();
        commitInput();
        return;
      }
    }

    if (e.key === "," || e.key === ";") {
      e.preventDefault();
      commitInput();
      return;
    }

    if (e.key === "Backspace" && !inputValue && recipients.length > 0) {
      removeRecipient(recipients.length - 1);
      return;
    }

    if (e.key === "Escape") {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, -1));
      return;
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setInputValue(val);

    // Debounce search
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (val.trim().length >= 1) {
      debounceRef.current = setTimeout(async () => {
        const results = await searchContacts(val.trim());
        // Filter out already-added recipients
        const filtered = results.filter(
          (c) => !recipients.some((r) => r.address.toLowerCase() === c.email.toLowerCase())
        );
        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
        setHighlightedIndex(-1);
      }, 200);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (text.includes(",") || text.includes(";") || text.includes(" ")) {
      e.preventDefault();
      const parts = text.split(/[,;\s]+/).filter(Boolean);
      let newRecipients = [...recipients];
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed && !newRecipients.some((r) => r.address.toLowerCase() === trimmed.toLowerCase())) {
          newRecipients = [...newRecipients, { address: trimmed }];
        }
      }
      setRecipients(newRecipients);
      syncToParent(newRecipients);
    }
  }

  function handleSuggestionClick(contact: Contact) {
    addRecipient(contact.email, contact.name);
    inputRef.current?.focus();
  }

  function handleBlur() {
    // Delay to allow suggestion clicks
    setTimeout(() => {
      if (inputValue.trim()) {
        commitInput();
      }
      setShowSuggestions(false);
      // Reduire a nouveau la liste une fois l'edition terminee.
      setExpanded(false);
    }, 200);
  }

  function expand() {
    setExpanded(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Reduire la liste quand elle contient plusieurs destinataires et qu'on ne
  // l'edite pas activement.
  const collapsed = !expanded && recipients.length > 1;

  return (
    <Popover open={showSuggestions} onOpenChange={setShowSuggestions}>
      <PopoverAnchor asChild>
        <div
          data-ref={dataRef}
          role={collapsed ? "button" : undefined}
          tabIndex={collapsed ? 0 : undefined}
          aria-label={collapsed ? `${recipients.length} ${t("compose.recipients")}` : undefined}
          className={cn(
            "border-input flex min-h-9 min-w-0 items-center gap-1 rounded-md border bg-transparent px-2 py-1 text-[0.8125rem] shadow-xs",
            collapsed ? "flex-nowrap cursor-pointer" : "flex-wrap",
            "focus-within:ring-ring/50 focus-within:ring-[3px] focus-within:border-ring",
            className
          )}
          onClick={() => (collapsed ? expand() : inputRef.current?.focus())}
          onKeyDown={
            collapsed
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    expand();
                  }
                }
              : undefined
          }
        >
          {collapsed ? (
            <>
              <span className="min-w-0 flex-1 truncate" data-ref="recipient-chip-label">
                {labelOf(recipients[0])}
              </span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                +{recipients.length - 1}
              </span>
              <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden />
            </>
          ) : (
            <>
              {recipients.map((r, i) => (
                <span
                  key={`${r.address}-${i}`}
                  title={labelOf(r) !== r.address ? r.address : undefined}
                  data-ref="recipient-chip"
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-1 pr-1.5 pl-2.5 text-[0.8125rem] text-foreground"
                >
                  <span className="min-w-0 max-w-[12rem] truncate" data-ref="recipient-chip-label">{labelOf(r)}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecipient(i);
                    }}
                    className="text-muted-foreground hover:text-foreground ml-0.5 rounded-full p-0.5"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setExpanded(true)}
                onBlur={handleBlur}
                placeholder={recipients.length === 0 ? placeholder : ""}
                className={cn(
                  "flex-1 bg-transparent py-0.5 text-[0.8125rem] outline-none placeholder:text-muted-foreground",
                  // Hors saisie, le champ ne reserve pas de place a cote des
                  // pastilles (sinon une seule adresse passe sur deux lignes).
                  expanded || recipients.length === 0 ? "min-w-[4.5rem]" : "w-0 min-w-0"
                )}
              />
            </>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        data-ref="recipient-suggestions"
        className="z-[100] w-[var(--radix-popover-trigger-width)] p-1"
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
              onClick={() => handleSuggestionClick(contact)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                index === highlightedIndex && "bg-accent text-accent-foreground"
              )}
            >
              <div
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
                style={{ backgroundColor: getAvatarColor(contact.email) }}
              >
                {getInitials(contact.name || contact.email)}
              </div>
              <div className="min-w-0 flex-1 text-left">
                {contact.name && (
                  <div className="truncate text-sm">{contact.name}</div>
                )}
                <div className="truncate text-xs text-muted-foreground">{contact.email}</div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
