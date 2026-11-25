"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2, Plug, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import pb, { apiKeys, type ApiKey } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Meme seuil que le worker (api-keys.ts) : au-dela, la cle est signalee. */
const INACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_PLACEHOLDER = "<VOTRE_CLE>";

function parseDate(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v.replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
}

function isInactive(k: ApiKey): boolean {
  const last = parseDate(k.last_used) ?? parseDate(k.created);
  return last !== null && Date.now() - last >= INACTIVE_DAYS * DAY_MS;
}

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("connectivity.copyFailed"));
    }
  }
  return (
    <div className="space-y-1">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <div className="flex items-start gap-2 rounded-md bg-muted p-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs select-text">
          {text}
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={copy}
          aria-label={t("connectivity.copy")}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/** Exemples prets a coller, remplis avec la cle quand on la connait. */
function connectExamples(url: string, key: string) {
  const claudeCode = `claude mcp add --transport http imiel ${url} --header "Authorization: Bearer ${key}"`;
  const json = JSON.stringify(
    { mcpServers: { imiel: { type: "http", url, headers: { Authorization: `Bearer ${key}` } } } },
    null,
    2,
  );
  const local = JSON.stringify(
    {
      mcpServers: {
        imiel: {
          command: "node",
          args: ["/chemin/vers/mcp/imiel-mcp/dist/index.js"],
          env: { IMIEL_URL: url.replace(/\/worker\/mcp$/, ""), IMIEL_API_KEY: key },
        },
      },
    },
    null,
    2,
  );
  return { claudeCode, json, local };
}

/**
 * Reglages > Connectivite : cles d'acces du connecteur MCP en ligne
 * (creation via le worker, liste/suppression via PocketBase) et mode d'emploi
 * pour brancher un outil externe (Claude, ChatGPT, automatisations).
 */
export default function ConnectivitySettings() {
  const t = useT();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "full">("read");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null);
  const [toDelete, setToDelete] = useState<ApiKey | null>(null);

  const mcpUrl = useMemo(
    () => (typeof window !== "undefined" ? `${window.location.origin}/worker/mcp` : "/worker/mcp"),
    [],
  );

  const load = useCallback(async () => {
    try {
      setKeys(await apiKeys().getFullList({ sort: "-created" }));
    } catch {
      toast.error(t("connectivity.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/worker/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
        body: JSON.stringify({ name: name.trim(), scope }),
      });
      const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !data.key) throw new Error(data.error || String(res.status));
      setRevealed({ key: data.key, name: name.trim() });
      setCreateOpen(false);
      setName("");
      setScope("read");
      void load();
    } catch {
      toast.error(t("connectivity.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(k: ApiKey) {
    setToDelete(null);
    setKeys((prev) => prev.filter((x) => x.id !== k.id));
    try {
      await apiKeys().delete(k.id);
      toast.success(t("connectivity.deleted"));
    } catch {
      toast.error(t("connectivity.deleteFailed"));
      void load();
    }
  }

  const examples = connectExamples(mcpUrl, KEY_PLACEHOLDER);
  const revealedExamples = revealed ? connectExamples(mcpUrl, revealed.key) : null;

  return (
    <div data-ref="settings-connectivity" className="space-y-8">
      <div>
        <h3 className="text-lg font-medium">{t("settings.connectivity")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("connectivity.intro")}</p>
      </div>

      {/* Cles d'acces */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4" />
            {t("connectivity.keysTitle")}
          </h4>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t("connectivity.newKey")}
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {t("connectivity.noKeys")}
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {keys.map((k) => {
              const inactive = isInactive(k);
              const lastUsed = parseDate(k.last_used);
              const created = parseDate(k.created);
              return (
                <li key={k.id} data-ref="api-key-row" className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{k.name}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px] font-medium",
                          k.scope === "full"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {k.scope === "full" ? t("connectivity.scopeFull") : t("connectivity.scopeRead")}
                      </span>
                      {inactive && (
                        <span className="flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                          <TriangleAlert className="size-3" />
                          {t("connectivity.inactive")}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="font-mono">{k.prefix}…</span>
                      {" · "}
                      {t("connectivity.createdOn", {
                        date: created ? new Date(created).toLocaleDateString() : "-",
                      })}
                      {" · "}
                      {lastUsed
                        ? t("connectivity.lastUsed", { date: new Date(lastUsed).toLocaleString() })
                        : t("connectivity.neverUsed")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setToDelete(k)}
                    aria-label={t("connectivity.delete")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("connectivity.keysHint")}</p>
      </section>

      {/* Connecter un outil externe */}
      <section className="space-y-3">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <Plug className="size-4" />
          {t("connectivity.connectTitle")}
        </h4>
        <p className="text-sm text-muted-foreground">{t("connectivity.connectIntro")}</p>
        <CopyBlock text={mcpUrl} label={t("connectivity.urlLabel")} />
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>{t("connectivity.step1")}</li>
          <li>{t("connectivity.step2")}</li>
          <li>{t("connectivity.step3")}</li>
        </ol>
        <CopyBlock text={examples.claudeCode} label={t("connectivity.exampleClaudeCode")} />
        <CopyBlock text={examples.json} label={t("connectivity.exampleJson")} />
        <p className="text-xs text-muted-foreground">{t("connectivity.exampleOthers")}</p>
        <CopyBlock text={examples.local} label={t("connectivity.exampleLocal")} />
        <p className="text-xs text-muted-foreground">{t("connectivity.readOnlyHint")}</p>
      </section>

      {/* Creation */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("connectivity.newKey")}</DialogTitle>
            <DialogDescription>{t("connectivity.createIntro")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="api-key-name">{t("connectivity.nameLabel")}</Label>
              <Input
                id="api-key-name"
                value={name}
                maxLength={80}
                placeholder={t("connectivity.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                }}
              />
            </div>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as "read" | "full")} className="gap-3">
              <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                <RadioGroupItem value="read" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">{t("connectivity.scopeRead")}</span>
                  <span className="block text-xs text-muted-foreground">{t("connectivity.scopeReadHint")}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                <RadioGroupItem value="full" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">{t("connectivity.scopeFull")}</span>
                  <span className="block text-xs text-muted-foreground">{t("connectivity.scopeFullHint")}</span>
                </span>
              </label>
            </RadioGroup>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating && <Loader2 className="size-4 animate-spin" />}
              {t("connectivity.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cle montree une seule fois */}
      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("connectivity.revealTitle", { name: revealed?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("connectivity.revealWarning")}</DialogDescription>
          </DialogHeader>
          {revealed && revealedExamples && (
            <div className="min-w-0 space-y-3">
              <CopyBlock text={revealed.key} label={t("connectivity.keyLabel")} />
              <CopyBlock text={revealedExamples.claudeCode} label={t("connectivity.exampleClaudeCode")} />
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>{t("connectivity.revealDone")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suppression */}
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("connectivity.deleteTitle", { name: toDelete?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("connectivity.deleteWarning")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => toDelete && void handleDelete(toDelete)}
            >
              {t("connectivity.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
