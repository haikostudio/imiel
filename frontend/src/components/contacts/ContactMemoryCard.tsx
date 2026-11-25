"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/utils/date";
import pb, { contactMemories, type ContactMemory } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";

// Encadre "Ce que l'IA sait" : la memoire "qui est qui" donnee a l'IA de
// reponse (worker contact-memory.ts). Visible et corrigeable ; la correction
// de l'utilisateur prime toujours :
// - un champ corrige passe dans `locked` (l'IA ne le reecrit plus),
// - un fait retire passe dans `dismissed` (l'IA ne le remet plus),
// - la note libre n'est jamais touchee par l'IA.
// memoryKey="me" : la fiche de l'utilisateur lui-meme (Reglages > IA).

type TextField = "role" | "organization" | "relation";
const TEXT_FIELDS: TextField[] = ["role", "organization", "relation"];

interface ContactMemoryCardProps {
  /** Adresse principale (cle) ou "me". */
  memoryKey: string;
  /** Autres adresses de la meme personne (fiches contact au meme nom). */
  addresses?: string[];
  name?: string;
  /** Autres personnes du dossier (aident l'IA a situer les roles). */
  participants?: string[];
  /** Construit la fiche toute seule si elle n'existe pas (onglet Analyse du fil). */
  autoBuild?: boolean;
  className?: string;
}

// Construction d'office : une seule tentative par personne et par session (une
// fiche "empty" = robot ou aucun vrai echange, ne se relance pas a chaque
// ouverture) et au plus 2 appels IA a la fois, quel que soit le nombre de
// cartes montees.
const autoTried = new Set<string>();
const AUTO_MAX_PARALLEL = 2;
let autoRunning = 0;
const autoWaiters: (() => void)[] = [];
async function withAutoSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (autoRunning >= AUTO_MAX_PARALLEL) await new Promise<void>((r) => autoWaiters.push(r));
  autoRunning++;
  try {
    return await fn();
  } finally {
    autoRunning--;
    autoWaiters.shift()?.();
  }
}

// Le modele ecrit "MOI" (etiquette des prompts) : a l'ecran, "moi".
function shown(v: string): string {
  return v.replace(/\bMOI\b/g, "moi");
}

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function ContactMemoryCard({
  memoryKey,
  addresses = [],
  name = "",
  participants = [],
  autoBuild = false,
  className,
}: ContactMemoryCardProps) {
  const t = useT();
  const isMe = memoryKey === "me";
  const key = memoryKey.trim().toLowerCase();
  const allAddrs = Array.from(new Set([key, ...addresses.map((a) => a.trim().toLowerCase())].filter(Boolean)));
  const addrKey = allAddrs.join(",");
  const [rec, setRec] = useState<ContactMemory | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TextField | null>(null);
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    const keys = addrKey.split(",").filter(Boolean);
    const filter = isMe
      ? `key = "me"`
      : keys.map((a) => `key = "${esc(a)}" || addresses ~ "\\"${esc(a)}\\""`).join(" || ");
    try {
      const res = await contactMemories().getList(1, 1, { filter, sort: "-updated", skipTotal: true });
      const r = res.items[0] || null;
      setRec(r);
      setNotes(r?.user_notes || "");
    } catch {
      setRec(null);
    } finally {
      setLoading(false);
    }
  }, [addrKey, isMe]);

  useEffect(() => {
    setLoading(true);
    setEditing(null);
    void load();
  }, [load]);

  // Ecrit (ou cree) la fiche ; optimiste : l'ecran suit tout de suite.
  const save = useCallback(
    async (patch: Partial<ContactMemory>) => {
      const userId = pb.authStore.record?.id;
      if (!userId) return;
      try {
        const next = rec
          ? await contactMemories().update(rec.id, patch)
          : await contactMemories().create({
              user: userId,
              key: isMe ? "me" : key,
              name: isMe ? "Moi" : name,
              addresses: isMe ? [] : allAddrs,
              ...patch,
            });
        setRec(next);
        toast.success(t("contactMemory.saved"));
      } catch {
        toast.error(t("contactMemory.error"));
      }
    },
    // allAddrs derive de addrKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rec, isMe, key, name, addrKey, t]
  );

  const saveField = async (field: TextField) => {
    const value = draft.trim();
    setEditing(null);
    if (value === (rec?.[field] || "")) return;
    const locked = Array.from(new Set([...(rec?.locked || []), field]));
    await save({ [field]: value, locked } as Partial<ContactMemory>);
  };

  const removeFact = async (fact: string) => {
    await save({
      facts: (rec?.facts || []).filter((f) => f !== fact),
      dismissed: Array.from(new Set([...(rec?.dismissed || []), fact])),
    });
  };

  const saveNotes = async () => {
    if (notes.trim() === (rec?.user_notes || "").trim()) return;
    await save({ user_notes: notes.trim() });
  };

  // Construction / mise a jour a la demande (ex. reprendre tout de suite les
  // echanges d'une personne du dossier). Sans nouveau mail : aucun appel IA.
  // `auto` (construction d'office) : aucun toast, l'etat se lit dans la carte.
  const analyze = async (auto = false) => {
    setAnalyzing(true);
    try {
      const call = () =>
        fetch("/worker/contact-memory/ensure", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
          body: JSON.stringify({ addresses: allAddrs, name, participants }),
        });
      const res = auto ? await withAutoSlot(call) : await call();
      if (!res.ok) throw new Error(String(res.status));
      const out = (await res.json()) as { status?: string };
      if (!auto) {
        if (out.status === "unchanged") toast(t("contactMemory.nothingNew"));
        else if (out.status === "empty") toast(t("contactMemory.noExchange"));
        else if (out.status === "error") toast.error(t("contactMemory.error"));
        else toast.success(t("contactMemory.done"));
      }
      await load();
    } catch {
      if (!auto) toast.error(t("contactMemory.error"));
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    if (!autoBuild || isMe || loading || rec || !addrKey || autoTried.has(addrKey)) return;
    autoTried.add(addrKey);
    void analyze(true);
    // analyze lit l'etat courant ; on ne relance que sur la fin du chargement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBuild, isMe, loading, rec, addrKey]);

  const facts = rec?.facts || [];
  const related = (rec?.related || []).filter((p) => p.name || p.address);
  const fields = isMe ? (["role"] as TextField[]) : TEXT_FIELDS;
  const hasContent = !!rec && (fields.some((f) => rec[f]) || facts.length > 0 || related.length > 0);

  return (
    <div data-ref={isMe ? "settings-ai-me-memory" : "contact-memory"} className={cn("space-y-3 rounded-lg border p-4", className)}>
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {isMe ? t("contactMemory.meTitle") : t("contactMemory.title")}
        </h3>
        {!isMe && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void analyze()}
            disabled={analyzing || loading}
            data-ref="contact-memory-analyze"
            title={t("contactMemory.analyze")}
          >
            {analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="max-sm:hidden">{analyzing ? t("contactMemory.analyzing") : t("contactMemory.analyze")}</span>
          </Button>
        )}
      </div>

      {isMe && <p className="text-xs text-muted-foreground">{t("contactMemory.meHelp")}</p>}

      {loading ? (
        <div className="flex justify-center py-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {!hasContent && !isMe && (
            <p className="text-sm text-muted-foreground" data-ref={analyzing ? "contact-memory-building" : undefined}>
              {analyzing ? t("contactMemory.building") : t("contactMemory.empty")}
            </p>
          )}

          {(hasContent || isMe) &&
            fields.map((field) => {
              const value = rec?.[field] || "";
              const corrected = (rec?.locked || []).includes(field);
              if (!value && !isMe && editing !== field) return null;
              return (
                <div key={field} className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {t(`contactMemory.${field}`)}
                    {corrected && <span className="rounded-full bg-muted px-1.5 text-[10px]">{t("contactMemory.corrected")}</span>}
                  </div>
                  {editing === field ? (
                    <div className="flex items-center gap-1">
                      <Input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveField(field);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="h-8"
                        autoFocus
                      />
                      <Button variant="ghost" size="icon-sm" onClick={() => void saveField(field)}>
                        <Check className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditing(null)}>
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(value);
                        setEditing(field);
                      }}
                      className="group flex w-full items-start gap-1.5 text-left text-sm"
                      title={t("contactMemory.edit")}
                    >
                      <span className={cn("min-w-0 flex-1", !value && "text-muted-foreground")}>{shown(value) || "-"}</span>
                      <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
                    </button>
                  )}
                </div>
              );
            })}

          {facts.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{t("contactMemory.facts")}</div>
              <ul className="space-y-1">
                {facts.map((f) => (
                  <li key={f} className="group flex items-start gap-1.5 text-sm">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                    <span className="min-w-0 flex-1">{shown(f)}</span>
                    <button
                      type="button"
                      onClick={() => void removeFact(f)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100"
                      title={t("contactMemory.removeFact")}
                      aria-label={t("contactMemory.removeFact")}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {related.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{t("contactMemory.related")}</div>
              <ul className="space-y-1">
                {related.map((p) => (
                  <li key={p.address || p.name} className="text-sm">
                    <span className="font-medium">{p.name || p.address}</span>
                    {p.role && <span className="text-muted-foreground"> - {shown(p.role)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{t("contactMemory.notes")}</div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => void saveNotes()}
              placeholder={isMe ? t("contactMemory.meNotesPlaceholder") : t("contactMemory.notesPlaceholder")}
              rows={2}
              className="min-h-16 text-base md:text-sm"
              data-ref="contact-memory-notes"
            />
          </div>

          {rec?.built_at && (
            <p className="text-xs text-muted-foreground">
              {t("contactMemory.updated", {
                date: formatRelativeDate(rec.built_at),
                count: String(rec.analyzed_count || 0),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
