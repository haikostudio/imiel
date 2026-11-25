"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import pb from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Cle de comparaison (meme regle que le worker, newsletter-tags.ts). */
export function foldTag(tag: string): string {
  return (tag || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Etiquette saisie a la main : nettoyee, alignee sur l'ecriture existante. */
export function normalizeTagInput(raw: string, known: string[]): string {
  let t = raw.replace(/^[\s#]+/, "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!t) return "";
  const existing = known.find((k) => foldTag(k) === foldTag(t));
  if (existing) return existing;
  if (t === t.toLowerCase()) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

let knownCache: { at: number; tags: string[] } | null = null;

/** Etiquettes deja employees (suggestions), lues au worker, cache 5 min. */
export function useKnownNewsletterTags(): string[] {
  const [tags, setTags] = useState<string[]>(knownCache?.tags ?? []);
  useEffect(() => {
    if (knownCache && Date.now() - knownCache.at < 5 * 60 * 1000) return;
    let cancelled = false;
    fetch("/worker/newsletters/tags", { headers: { Authorization: pb.authStore.token } })
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d: { tags?: string[] }) => {
        knownCache = { at: Date.now(), tags: d.tags || [] };
        if (!cancelled) setTags(knownCache.tags);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return tags;
}

export function invalidateKnownNewsletterTags() {
  knownCache = null;
}

/**
 * Pastilles d'etiquettes d'une newsletter : clic = filtrer la liste, croix =
 * retirer, "+" = ajouter (avec les etiquettes existantes proposees). Les clics
 * ne remontent pas a la carte (qui ouvre le detail).
 */
export function NewsletterTagChips({
  tags,
  known,
  activeTag,
  onFilter,
  onChange,
}: {
  tags: string[];
  known: string[];
  activeTag?: string | null;
  onFilter: (tag: string) => void;
  onChange: (tags: string[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const suggestions = useMemo(() => {
    const have = new Set(tags.map(foldTag));
    const q = foldTag(value);
    return known.filter((k) => !have.has(foldTag(k)) && (!q || foldTag(k).includes(q))).slice(0, 8);
  }, [known, tags, value]);

  function add(raw: string) {
    const tag = normalizeTagInput(raw, known);
    if (!tag || tags.some((x) => foldTag(x) === foldTag(tag)) || tags.length >= 8) {
      setValue("");
      return;
    }
    onChange([...tags, tag]);
    setValue("");
    setOpen(false);
  }

  return (
    <div
      data-ref="newsletter-tags"
      className="mt-2 flex flex-wrap items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {tags.map((tag) => {
        const active = !!activeTag && foldTag(activeTag) === foldTag(tag);
        return (
          <span
            key={tag}
            className={cn(
              "group inline-flex items-center rounded-full text-[11px] font-medium",
              active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            <button
              type="button"
              className="py-0.5 pl-2 pr-1 hover:underline"
              onClick={() => onFilter(tag)}
              title={t("newsletters.tagFilter", { tag })}
            >
              {tag}
            </button>
            <button
              type="button"
              className="rounded-full py-0.5 pr-1.5 pl-0.5 opacity-60 hover:opacity-100"
              onClick={() => onChange(tags.filter((x) => x !== tag))}
              aria-label={t("newsletters.tagRemove", { tag })}
              title={t("newsletters.tagRemove", { tag })}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
            aria-label={t("newsletters.tagAdd")}
            title={t("newsletters.tagAdd")}
          >
            {tags.length === 0 ? <Tag className="size-3" /> : null}
            <Plus className="size-3" />
            {tags.length === 0 && <span>{t("newsletters.tagAdd")}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-2" onClick={(e) => e.stopPropagation()}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add(value);
            }}
          >
            <Input
              autoFocus
              value={value}
              maxLength={40}
              placeholder={t("newsletters.tagPlaceholder")}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 text-sm"
            />
          </form>
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onClick={() => add(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
