"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardCopy, CopyPlus, Loader2, Mail, PenLine, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accounts as accountsCollection, type Account } from "@/lib/pocketbase";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { useHashRouter } from "@/lib/hash-router";
import { isSignatureEmpty, signatureImageUrl, toEmailSignatureHtml } from "@/lib/signature";
import { sanitizeHtml } from "@/lib/utils/sanitize";
import { useT, t as tStatic } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SignatureEditor } from "./SignatureEditor";

function accountLabel(a: Account): string {
  return a.email || a.label || a.display_name || a.id;
}

/**
 * Onglet Reglages > Signatures : une signature riche par adresse (compte).
 * Ouvrable directement sur un compte : #/settings?tab=signatures&account=<id>
 * (lien "Ajouter une signature" du brouillon).
 */
export default function SignatureSettings() {
  const t = useT();
  const { accounts, loading, updateAccount } = useAccounts();
  const { searchParams, replace } = useHashRouter();
  const requested = searchParams.get("account");

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => accountLabel(a).localeCompare(accountLabel(b))),
    [accounts]
  );
  const selected = sorted.find((a) => a.id === requested) ?? sorted[0] ?? null;

  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetKey, setResetKey] = useState("");
  const editorRef = useRef<Editor | null>(null);

  // Nouveau compte selectionne : recharge sa signature enregistree.
  useEffect(() => {
    if (!selected) return;
    setDraft(selected.signature || "");
    setDirty(false);
    setResetKey(`${selected.id}:${Date.now()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  function selectAccount(id: string) {
    if (dirty && !window.confirm(tStatic("signature.discardChanges"))) return;
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", "signatures");
    p.set("account", id);
    replace(`/settings?${p.toString()}`);
  }

  function loadFrom(source: Account) {
    setDraft(source.signature || "");
    setDirty(true);
    setResetKey(`${source.id}:copy:${Date.now()}`);
    toast.success(tStatic("signature.copiedFrom", { email: accountLabel(source) }));
  }

  async function uploadImage(file: File): Promise<string | null> {
    if (!selected) return null;
    if (file.size > 2 * 1024 * 1024) {
      toast.error(tStatic("signature.imageTooBig"));
      return null;
    }
    try {
      const before = new Set(selected.signature_images ?? []);
      const rec = await accountsCollection().update<Account>(selected.id, {
        "signature_images+": file,
      });
      const added = (rec.signature_images ?? []).find((f) => !before.has(f));
      if (!added) throw new Error("no file");
      return signatureImageUrl(rec, added);
    } catch {
      toast.error(tStatic("signature.imageError"));
      return null;
    }
  }

  async function save(html: string) {
    if (!selected) return;
    setSaving(true);
    try {
      const out = isSignatureEmpty(html) ? "" : toEmailSignatureHtml(html);
      await updateAccount(selected.id, { signature: out });
      setDirty(false);
      toast.success(out ? tStatic("signature.saved") : tStatic("signature.removed"));
    } catch {
      toast.error(tStatic("signature.saveError"));
    } finally {
      setSaving(false);
    }
  }

  function clearSignature() {
    editorRef.current?.commands.clearContent(true);
    setDraft("");
    setDirty(true);
  }

  // Copie la signature rendue (HTML + texte) : se colle telle quelle dans une
  // autre messagerie ou dans l'editeur d'une autre adresse.
  async function copyToClipboard() {
    const html = toEmailSignatureHtml(draft);
    if (!html) return;
    const text = new DOMParser().parseFromString(html, "text/html").body.innerText;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      toast.success(tStatic("signature.copied"));
    } catch {
      toast.error(tStatic("signature.copyError"));
    }
  }

  const preview = useMemo(
    () => sanitizeHtml(toEmailSignatureHtml(draft), { allowExternalImages: true }),
    [draft]
  );
  const others = sorted.filter((a) => a.id !== selected?.id && !isSignatureEmpty(a.signature));
  const empty = isSignatureEmpty(draft);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm">
        <Mail className="size-6 opacity-50" />
        {t("signature.noAccount")}
      </div>
    );
  }

  return (
    <div data-ref="settings-signatures" className="flex flex-col gap-5">
      <div>
        <h2 className="text-base font-semibold">{t("settings.signatures")}</h2>
        <p className="text-muted-foreground text-sm">{t("signature.intro")}</p>
      </div>

      <div className="flex flex-col gap-4 md:flex-row">
        {/* Adresses : liste (ordinateur) / menu deroulant (telephone) */}
        <div className="md:hidden">
          <Select value={selected.id} onValueChange={selectAccount}>
            <SelectTrigger className="w-full" data-ref="signature-account-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {sorted.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {accountLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <nav data-ref="signature-accounts" className="hidden w-56 shrink-0 flex-col gap-0.5 md:flex">
          {sorted.map((a) => {
            const has = !isSignatureEmpty(a.signature);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => selectAccount(a.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  a.id === selected.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: a.color || "#9ca3af" }}
                />
                <span className="min-w-0 flex-1 truncate">{accountLabel(a)}</span>
                {has && <PenLine className="text-muted-foreground size-3.5 shrink-0" aria-label={t("signature.hasSignature")} />}
              </button>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" data-ref="signature-copy-from">
                    <CopyPlus className="size-4" />
                    {t("signature.copyFrom")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {others.map((a) => (
                    <DropdownMenuItem key={a.id} onSelect={() => loadFrom(a)}>
                      {accountLabel(a)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button type="button" variant="outline" size="sm" disabled={empty} onClick={copyToClipboard} data-ref="signature-copy">
              <ClipboardCopy className="size-4" />
              {t("signature.copy")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={empty}
              onClick={clearSignature}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
              {t("signature.clear")}
            </Button>
          </div>

          <SignatureEditor
            content={draft}
            resetKey={resetKey}
            editorRef={editorRef}
            onChange={(html) => {
              setDraft(html);
              setDirty(true);
            }}
            onUploadImage={uploadImage}
          />

          <div>
            <div className="text-muted-foreground mb-1.5 text-xs font-medium">{t("signature.preview")}</div>
            <div
              data-ref="signature-preview"
              className="min-h-16 overflow-x-auto rounded-md border bg-white px-4 py-3 text-[14px] leading-normal text-[#111827]"
            >
              {empty ? (
                <span className="text-xs italic text-gray-400">{t("signature.previewEmpty")}</span>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: preview }} />
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            {dirty && <span className="text-muted-foreground text-xs">{t("signature.unsaved")}</span>}
            <Button type="button" onClick={() => save(draft)} disabled={!dirty || saving} data-ref="signature-save">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {t("save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
