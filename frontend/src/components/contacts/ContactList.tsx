"use client";

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/mail/ContactAvatar";
import { usePullToRefresh } from "@/lib/hooks/usePullToRefresh";
import { PullToRefreshIndicator, ptrGapOf } from "@/components/ui/pull-to-refresh";
import type { Contact } from "@/lib/pocketbase";

interface ContactListProps {
  contacts: Contact[];
  selectedId: string | null;
  onSelect: (contact: Contact) => void;
  searchQuery: string;
  /** Tirer-pour-rafraichir (mobile) : recharge le carnet. */
  onRefresh?: () => Promise<unknown> | void;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");

function getInitialLetter(contact: Contact): string {
  const name = contact.name || contact.email;
  const first = name.charAt(0).toUpperCase();
  if (first >= "A" && first <= "Z") return first;
  return "#";
}

export function ContactList({ contacts, selectedId, onSelect, searchQuery, onRefresh }: ContactListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [currentLetter, setCurrentLetter] = useState<string>("");
  const ptr = usePullToRefresh(scrollRef, onRefresh);
  const ptrGap = ptrGapOf(ptr);

  const filtered = useMemo(() => {
    if (!searchQuery) return contacts;
    const q = searchQuery.toLowerCase();
    return contacts.filter(
      (c) =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        c.email.toLowerCase().includes(q)
    );
  }, [contacts, searchQuery]);

  const grouped = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const contact of filtered) {
      const letter = getInitialLetter(contact);
      const group = map.get(letter) || [];
      group.push(contact);
      map.set(letter, group);
    }
    const sorted = new Map(
      [...map.entries()].sort((a, b) => {
        if (a[0] === "#") return 1;
        if (b[0] === "#") return -1;
        return a[0].localeCompare(b[0]);
      })
    );
    return sorted;
  }, [filtered]);

  const activeLetters = useMemo(() => new Set(grouped.keys()), [grouped]);

  // Detect current visible letter via scroll position
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    let found = "";
    for (const [letter, el] of sectionRefs.current) {
      if (el.offsetTop <= scrollTop + 40) {
        found = letter;
      }
    }
    if (found && found !== currentLetter) {
      setCurrentLetter(found);
    }
  }, [currentLetter]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.addEventListener("scroll", handleScroll, { passive: true });
    // Set initial letter
    const letters = [...grouped.keys()];
    if (letters.length > 0 && !currentLetter) {
      setCurrentLetter(letters[0]);
    }
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll, grouped, currentLetter]);

  function scrollToLetter(letter: string) {
    const el = sectionRefs.current.get(letter);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div data-ref="contact-list" className="relative h-full">
      {onRefresh && <PullToRefreshIndicator {...ptr} />}
      <div ref={scrollRef} className="h-full overflow-y-auto pr-8">
        <div
          className={ptr.dragging ? undefined : "ptr-content--snap"}
          style={ptrGap > 0 ? { transform: `translateY(${ptrGap}px)` } : undefined}
        >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-sm text-muted-foreground">
              {searchQuery ? "Aucun resultat" : ""}
            </p>
          </div>
        ) : (
          <div className="py-1">
            {[...grouped.entries()].map(([letter, group]) => (
              <div
                key={letter}
                ref={(el) => {
                  if (el) sectionRefs.current.set(letter, el);
                }}
              >
                <div data-ref="contact-letter" className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm px-[10px] py-1 md:px-4">
                  <span className="text-xs font-semibold text-muted-foreground">{letter}</span>
                </div>
                {group.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    data-ref="contact-row"
                    onClick={() => onSelect(contact)}
                    className={cn(
                      "flex w-full items-center gap-3 px-[10px] py-2.5 text-left text-sm transition-colors md:px-4",
                      "hover:bg-accent hover:text-accent-foreground",
                      selectedId === contact.id && "bg-accent text-accent-foreground"
                    )}
                  >
                    <ContactAvatar
                      name={contact.name}
                      email={contact.email}
                      className="size-8 shrink-0"
                      textClassName="text-xs"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {contact.name || contact.email}
                      </div>
                      {contact.name && (
                        <div className="truncate text-xs text-muted-foreground">
                          {contact.email}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Floating alphabet sidebar */}
      {filtered.length > 0 && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-0.5 py-2 px-1 bg-background/90 backdrop-blur-sm rounded-full">
          {ALPHABET.map((letter) => (
            <button
              key={letter}
              type="button"
              disabled={!activeLetters.has(letter)}
              onClick={() => scrollToLetter(letter)}
              className={cn(
                "w-5 text-center text-[10px] font-medium leading-[16px] transition-colors rounded-full",
                currentLetter === letter
                  ? "bg-primary text-primary-foreground"
                  : activeLetters.has(letter)
                    ? "text-muted-foreground hover:text-primary cursor-pointer"
                    : "text-muted-foreground/20 cursor-default"
              )}
            >
              {letter}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
