"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getOpenRouterKey,
  setOpenRouterKey,
  getCerveauKey,
  setCerveauKey,
  getPauseFlag,
  setPauseFlag,
} from "@/lib/ai-settings";
import { getCurrentUserId } from "@/lib/pocketbase";
import { ContactMemoryCard } from "@/components/contacts/ContactMemoryCard";
import { useT } from "@/lib/i18n";

interface MemoryStatus {
  totalMessages: number;
  embedded: number;
  backfill: {
    running: boolean;
    paused?: boolean;
    total: number;
    done: number;
    error: string | null;
    events?: string[];
  };
}

interface CategorizeStatus {
  totalUncategorized: number;
  windowDays: number;
  backfill: { running: boolean; paused?: boolean; total: number; done: number; error: string | null };
}

interface AiBudgetStatus {
  spentUsd: number;
  limitUsd: number;
  exceeded: boolean;
  resetsAt: string;
}

interface CerveauStatus {
  configured: boolean;
  totalMessages: number;
  totalBriefs: number;
  total: number;
  backfill: {
    phase: "idle" | "analyzing" | "analyzed" | "sending" | "done";
    running: boolean;
    paused?: boolean;
    total: number;
    done: number;
    eligible: number;
    pushed: number;
    error: string | null;
  };
}

export default function AiSettings() {
  const t = useT();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [catStatus, setCatStatus] = useState<CategorizeStatus | null>(null);
  const [syncPaused, setSyncPaused] = useState(false);
  const [embPaused, setEmbPaused] = useState(false);
  const [catPaused, setCatPaused] = useState(false);
  // Cerveau (memoire centrale)
  const [cerveauValue, setCerveauValue] = useState("");
  const [cerveauShow, setCerveauShow] = useState(false);
  const [cerveauSaving, setCerveauSaving] = useState(false);
  const [cerveauTesting, setCerveauTesting] = useState(false);
  const [cerveauStatus, setCerveauStatus] = useState<CerveauStatus | null>(null);
  const [cerveauPaused, setCerveauPaused] = useState(false);
  // Plafond de depense IA journalier (worker /ai-budget, global a l'instance)
  const [budget, setBudget] = useState<AiBudgetStatus | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const [budgetSaving, setBudgetSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const catPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cerveauPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Curseur pour ne logger qu'une fois chaque event du backfill cote worker.
  const lastLoggedEventRef = useRef<string>("");

  async function handleSave() {
    setSaving(true);
    try {
      await setOpenRouterKey(value);
      toast.success(t("settings.aiKeySaved"));
    } catch {
      toast.error(t("error"));
    } finally {
      setSaving(false);
    }
  }

  const fetchStatus = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) {
      console.warn("[AiSettings] fetchStatus: pas de userId");
      return;
    }
    const url = `/worker/embeddings/status?userId=${encodeURIComponent(userId)}`;
    console.log("[AiSettings] fetchStatus ->", url);
    try {
      const res = await fetch(url);
      console.log("[AiSettings] fetchStatus <- HTTP", res.status, res.statusText);
      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        console.error("[AiSettings] fetchStatus body:", text);
        return;
      }
      const data = (await res.json()) as MemoryStatus;
      console.log("[AiSettings] fetchStatus data:", {
        embedded: data.embedded,
        total: data.totalMessages,
        backfill: { ...data.backfill, events: undefined },
        eventsCount: data.backfill.events?.length ?? 0,
      });
      // Log uniquement les nouveaux events du worker (ring buffer) dans
      // la console navigateur : la timeline complete reste visible meme si
      // tu n'as pas les logs serveur.
      const events = data.backfill.events ?? [];
      if (events.length > 0) {
        const last = lastLoggedEventRef.current;
        const startIdx = last
          ? events.findIndex((e) => e === last)
          : -1;
        const fresh = startIdx >= 0 ? events.slice(startIdx + 1) : events;
        for (const ev of fresh) console.log("[worker]", ev);
        lastLoggedEventRef.current = events[events.length - 1];
      }
      setStatus(data);
      if (data.backfill.running) {
        if (!pollRef.current) {
          console.log("[AiSettings] backfill running -> demarre poll 3s");
          pollRef.current = setInterval(fetchStatus, 3000);
        }
      } else if (pollRef.current) {
        console.log("[AiSettings] backfill stopped -> arrete poll");
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      console.error("[AiSettings] fetchStatus FAILED:", err);
    }
  }, []);

  const fetchCatStatus = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) {
      console.warn("[AiSettings] fetchCatStatus: pas de userId");
      return;
    }
    const url = `/worker/categorize/status?userId=${encodeURIComponent(userId)}`;
    console.log("[AiSettings] fetchCatStatus ->", url);
    try {
      const res = await fetch(url);
      console.log("[AiSettings] fetchCatStatus <- HTTP", res.status, res.statusText);
      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        console.error("[AiSettings] fetchCatStatus body:", text);
        return;
      }
      const data = (await res.json()) as CategorizeStatus;
      console.log("[AiSettings] fetchCatStatus data:", data);
      setCatStatus(data);
      if (data.backfill.running) {
        if (!catPollRef.current) {
          console.log("[AiSettings] categorize running -> demarre poll 3s");
          catPollRef.current = setInterval(fetchCatStatus, 3000);
        }
      } else if (catPollRef.current) {
        console.log("[AiSettings] categorize stopped -> arrete poll");
        clearInterval(catPollRef.current);
        catPollRef.current = null;
      }
    } catch (err) {
      console.error("[AiSettings] fetchCatStatus FAILED:", err);
    }
  }, []);

  const fetchCerveauStatus = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      const res = await fetch(
        `/worker/cerveau/status?userId=${encodeURIComponent(userId)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as CerveauStatus;
      setCerveauStatus(data);
      if (data.backfill.running) {
        if (!cerveauPollRef.current) {
          cerveauPollRef.current = setInterval(fetchCerveauStatus, 3000);
        }
      } else if (cerveauPollRef.current) {
        clearInterval(cerveauPollRef.current);
        cerveauPollRef.current = null;
      }
    } catch (err) {
      console.error("[AiSettings] fetchCerveauStatus FAILED:", err);
    }
  }, []);

  useEffect(() => {
    setValue(getOpenRouterKey());
    setCerveauValue(getCerveauKey());
    setSyncPaused(getPauseFlag("sync_paused"));
    setEmbPaused(getPauseFlag("ai_embeddings_paused"));
    setCatPaused(getPauseFlag("ai_categorize_paused"));
    setCerveauPaused(getPauseFlag("cerveau_paused"));
    fetchStatus();
    fetchCatStatus();
    fetchCerveauStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (catPollRef.current) clearInterval(catPollRef.current);
      if (cerveauPollRef.current) clearInterval(cerveauPollRef.current);
    };
  }, [fetchStatus, fetchCatStatus, fetchCerveauStatus]);

  async function handleSaveCerveau() {
    setCerveauSaving(true);
    try {
      await setCerveauKey(cerveauValue);
      // L'envoi reste desactive tant que l'utilisateur n'a pas analyse puis
      // active : rien ne part avant l'analyse.
      await setPauseFlag("cerveau_paused", true);
      setCerveauPaused(true);
      toast.success(t("settings.aiKeySaved"));
      fetchCerveauStatus();
    } catch {
      toast.error(t("error"));
    } finally {
      setCerveauSaving(false);
    }
  }

  async function handleTestCerveau() {
    const userId = getCurrentUserId();
    if (!userId) return;
    setCerveauTesting(true);
    try {
      // On enregistre d'abord la cle saisie pour tester la valeur courante.
      await setCerveauKey(cerveauValue);
      const res = await fetch("/worker/cerveau/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) toast.success(t("settings.cerveauTestOk"));
      else toast.error(data.error || t("settings.cerveauTestFail"));
    } catch {
      toast.error(t("settings.cerveauTestFail"));
    } finally {
      setCerveauTesting(false);
    }
  }

  // Phase 1 : lance l'analyse (dry-run). N'envoie rien. Enregistre la cle au
  // besoin pour que le worker puisse la lire.
  async function startCerveauAnalysis() {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      if (cerveauValue.trim()) await setCerveauKey(cerveauValue);
      const res = await fetch("/worker/cerveau/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error((d as { error?: string }).error || t("error"));
        return;
      }
      fetchCerveauStatus();
    } catch {
      toast.error(t("error"));
    }
  }

  // Phase 2 : envoie les mails reperes par l'analyse + active le push live des
  // nouveaux mails (leve la pause).
  async function startCerveauSend() {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      await setPauseFlag("cerveau_paused", false);
      setCerveauPaused(false);
      const res = await fetch("/worker/cerveau/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error((d as { error?: string }).error || t("error"));
        return;
      }
      fetchCerveauStatus();
    } catch {
      toast.error(t("error"));
    }
  }

  // Stoppe le backfill en cours. `disableLive` coupe aussi le push des
  // nouveaux mails (utilise quand on arrete l'envoi).
  async function stopCerveauRun(disableLive: boolean) {
    const userId = getCurrentUserId();
    try {
      if (disableLive) {
        await setPauseFlag("cerveau_paused", true);
        setCerveauPaused(true);
      }
      if (userId) {
        await fetch("/worker/cerveau/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        }).catch(() => {});
      }
      fetchCerveauStatus();
    } catch {
      toast.error(t("error"));
    }
  }

  async function handleIndex() {
    const userId = getCurrentUserId();
    if (!userId) {
      console.warn("[AiSettings] handleIndex: pas de userId");
      return;
    }
    console.log("[AiSettings] handleIndex start userId=", userId, "embPaused=", embPaused);
    try {
      // Si on relance apres une pause, lever le flag d'abord.
      if (embPaused) {
        console.log("[AiSettings] handleIndex: leve flag ai_embeddings_paused");
        await setPauseFlag("ai_embeddings_paused", false);
        setEmbPaused(false);
      }
      const res = await fetch("/worker/embeddings/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      console.log("[AiSettings] handleIndex <- HTTP", res.status, res.statusText);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        console.error("[AiSettings] handleIndex body:", d);
        toast.error((d as { error?: string }).error || t("error"));
        return;
      }
      const data = await res.json().catch(() => ({}));
      console.log("[AiSettings] handleIndex started:", data);
      fetchStatus();
    } catch (err) {
      console.error("[AiSettings] handleIndex FAILED:", err);
      toast.error(t("error"));
    }
  }

  async function handleCategorize() {
    const userId = getCurrentUserId();
    if (!userId) return;
    try {
      if (catPaused) {
        await setPauseFlag("ai_categorize_paused", false);
        setCatPaused(false);
      }
      const res = await fetch("/worker/categorize/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error((d as { error?: string }).error || t("error"));
        return;
      }
      fetchCatStatus();
    } catch {
      toast.error(t("error"));
    }
  }

  async function toggleSyncPause() {
    const next = !syncPaused;
    try {
      await setPauseFlag("sync_paused", next);
      setSyncPaused(next);
    } catch {
      toast.error(t("error"));
    }
  }

  async function toggleEmbPause() {
    const next = !embPaused;
    try {
      await setPauseFlag("ai_embeddings_paused", next);
      setEmbPaused(next);
      // Si on reprend, relancer immediatement le backfill.
      if (!next) {
        await handleIndex();
      } else {
        fetchStatus();
      }
    } catch {
      toast.error(t("error"));
    }
  }

  async function toggleCatPause() {
    const next = !catPaused;
    try {
      await setPauseFlag("ai_categorize_paused", next);
      setCatPaused(next);
      if (!next) {
        await handleCategorize();
      } else {
        fetchCatStatus();
      }
    } catch {
      toast.error(t("error"));
    }
  }

  const running = status?.backfill.running ?? false;
  const catRunning = catStatus?.backfill.running ?? false;
  const cerveauBf = cerveauStatus?.backfill;
  const cerveauRunning = cerveauBf?.running ?? false;
  const cerveauPhase = cerveauBf?.phase ?? "idle";
  const cerveauConfigured = cerveauStatus?.configured ?? false;
  const cerveauKeyPresent = !!cerveauValue.trim() || cerveauConfigured;
  const cerveauAnalyzed = cerveauPhase === "analyzed" && (cerveauBf?.eligible ?? 0) > 0;

  let cerveauStatusText = "...";
  if (cerveauStatus) {
    if (!cerveauConfigured) {
      cerveauStatusText = t("settings.cerveauNeedsKey");
    } else if (cerveauPhase === "analyzing") {
      cerveauStatusText = t("settings.cerveauAnalyzing", {
        done: String(cerveauBf?.done ?? 0),
        total: String(cerveauStatus.total),
      });
    } else if (cerveauPhase === "analyzed") {
      cerveauStatusText = t("settings.cerveauReady", {
        eligible: String(cerveauBf?.eligible ?? 0),
      });
    } else if (cerveauPhase === "sending") {
      cerveauStatusText = t("settings.cerveauSending", {
        pushed: String(cerveauBf?.pushed ?? 0),
        eligible: String(cerveauBf?.eligible ?? 0),
      });
    } else if (cerveauPhase === "done") {
      cerveauStatusText = t("settings.cerveauDone", {
        pushed: String(cerveauBf?.pushed ?? 0),
      });
    } else {
      cerveauStatusText = t("settings.cerveauIdlePrompt");
    }
  }

  const fetchBudget = useCallback(async () => {
    try {
      const res = await fetch("/worker/ai-budget");
      if (!res.ok) return;
      const data = (await res.json()) as AiBudgetStatus;
      setBudget(data);
      setBudgetInput((prev) => (prev === "" ? String(data.limitUsd) : prev));
    } catch {
      /* worker indisponible : encart laisse en "..." */
    }
  }, []);

  useEffect(() => {
    void fetchBudget();
    const id = setInterval(() => void fetchBudget(), 30_000);
    return () => clearInterval(id);
  }, [fetchBudget]);

  const handleBudgetSave = async () => {
    const limit = Number(budgetInput.replace(",", "."));
    if (!Number.isFinite(limit) || limit < 0 || limit > 1000) {
      toast.error(t("settings.aiBudgetInvalid"));
      return;
    }
    setBudgetSaving(true);
    try {
      const res = await fetch("/worker/ai-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limitUsd: limit }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AiBudgetStatus;
      setBudget(data);
      setBudgetInput(String(data.limitUsd));
      toast.success(t("settings.aiBudgetSaved"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBudgetSaving(false);
    }
  };

  return (
    <div data-ref="settings-ai" className="space-y-8">
      <h3 className="text-lg font-medium">{t("settings.ai")}</h3>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t("settings.aiKeyLabel")}</label>
        <p className="text-sm text-muted-foreground">{t("settings.aiKeyHelp")}</p>
        <div className="flex items-center gap-2">
          <div className="relative max-w-md flex-1">
            <Input
              type={show ? "text" : "password"}
              placeholder="sk-or-v1-..."
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
              title={show ? t("settings.aiKeyHide") : t("settings.aiKeyShow")}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      </div>

      <div className="border-t pt-6">
        <ContactMemoryCard memoryKey="me" />
      </div>

      <div data-ref="settings-ai-budget" className="space-y-3 border-t pt-6">
        <label className="text-sm font-medium">{t("settings.aiBudget")}</label>
        <p className="text-sm text-muted-foreground">{t("settings.aiBudgetHelp")}</p>
        <p className="text-sm">
          {budget
            ? t("settings.aiBudgetSpent", {
                spent: budget.spentUsd.toFixed(2),
                limit: budget.limitUsd.toFixed(2),
              })
            : "..."}
        </p>
        {budget && (
          <p className={budget.exceeded ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {budget.exceeded
              ? t("settings.aiBudgetReached", {
                  time: new Date(budget.resetsAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })
              : t("settings.aiBudgetActive")}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            aria-label={t("settings.aiBudgetLimit")}
            className="w-28"
          />
          <span className="text-sm text-muted-foreground">{t("settings.aiBudgetLimit")}</span>
          <Button size="sm" onClick={handleBudgetSave} disabled={budgetSaving}>
            {budgetSaving && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      </div>

      <div className="space-y-3 border-t pt-6">
        <label className="text-sm font-medium">{t("settings.aiSync")}</label>
        <p className="text-sm text-muted-foreground">{t("settings.aiSyncHelp")}</p>
        <p className="text-sm">
          {syncPaused ? t("settings.aiSyncPaused") : t("settings.aiSyncRunning")}
        </p>
        <Button size="sm" variant={syncPaused ? "default" : "outline"} onClick={toggleSyncPause}>
          {syncPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
          {syncPaused ? t("resume") : t("pause")}
        </Button>
      </div>

      <div className="space-y-3 border-t pt-6">
        <label className="text-sm font-medium">{t("settings.aiMemory")}</label>
        <p className="text-sm text-muted-foreground">
          {t("settings.aiMemoryHelp")}
        </p>

        <p className="text-sm">
          {status
            ? t("settings.aiMemoryStatus", {
                embedded: String(status.embedded),
                total: String(status.totalMessages),
              })
            : "..."}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={handleIndex} disabled={running || embPaused}>
            {running && <Loader2 className="size-4 animate-spin" />}
            {running
              ? `${t("settings.aiMemoryIndexing")} (${status?.embedded ?? 0}/${status?.totalMessages ?? 0})`
              : t("settings.aiMemoryIndex")}
          </Button>
          <Button size="sm" variant={embPaused ? "default" : "outline"} onClick={toggleEmbPause}>
            {embPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {embPaused ? t("resume") : t("pause")}
          </Button>
          {embPaused && (
            <span className="text-sm text-muted-foreground">{t("paused")}</span>
          )}
        </div>

        {status?.backfill.error && (
          <p className="text-sm text-destructive">{status.backfill.error}</p>
        )}
      </div>

      <div className="space-y-3 border-t pt-6">
        <label className="text-sm font-medium">{t("settings.aiCategorize")}</label>
        <p className="text-sm text-muted-foreground">
          {t("settings.aiCategorizeHelp")}
        </p>

        <p className="text-sm">
          {catStatus
            ? t("settings.aiCategorizeStatus", {
                count: String(catStatus.totalUncategorized),
              })
            : "..."}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={handleCategorize} disabled={catRunning || catPaused}>
            {catRunning && <Loader2 className="size-4 animate-spin" />}
            {catRunning
              ? `${t("settings.aiCategorizeRunning")} (${catStatus?.backfill.done ?? 0}/${catStatus?.backfill.total ?? 0})`
              : t("settings.aiCategorizeRun")}
          </Button>
          <Button size="sm" variant={catPaused ? "default" : "outline"} onClick={toggleCatPause}>
            {catPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {catPaused ? t("resume") : t("pause")}
          </Button>
          {catPaused && (
            <span className="text-sm text-muted-foreground">{t("paused")}</span>
          )}
        </div>

        {catStatus?.backfill.error && (
          <p className="text-sm text-destructive">{catStatus.backfill.error}</p>
        )}
      </div>

      <div className="space-y-3 border-t pt-6">
        <label className="text-sm font-medium">{t("settings.cerveau")}</label>
        <p className="text-sm text-muted-foreground">{t("settings.cerveauHelp")}</p>

        <div className="flex items-center gap-2">
          <div className="relative max-w-md flex-1">
            <Input
              type={cerveauShow ? "text" : "password"}
              placeholder="cerveau-..."
              value={cerveauValue}
              onChange={(e) => setCerveauValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setCerveauShow((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
              title={cerveauShow ? t("settings.aiKeyHide") : t("settings.aiKeyShow")}
            >
              {cerveauShow ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button size="sm" onClick={handleSaveCerveau} disabled={cerveauSaving}>
            {cerveauSaving && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleTestCerveau}
            disabled={cerveauTesting || !cerveauValue.trim()}
          >
            {cerveauTesting && <Loader2 className="size-4 animate-spin" />}
            {t("settings.cerveauTest")}
          </Button>
        </div>

        <p className="text-sm">{cerveauStatusText}</p>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Phase 1 : analyse (n'envoie rien) */}
          <Button
            size="sm"
            variant="outline"
            onClick={
              cerveauPhase === "analyzing"
                ? () => stopCerveauRun(false)
                : startCerveauAnalysis
            }
            disabled={!cerveauKeyPresent || cerveauPhase === "sending"}
          >
            {cerveauPhase === "analyzing" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {cerveauPhase === "analyzing"
              ? t("settings.cerveauStopAnalysis")
              : t("settings.cerveauAnalyze")}
          </Button>

          {/* Phase 2 : envoi (active seulement apres analyse) */}
          <Button
            size="sm"
            onClick={
              cerveauPhase === "sending"
                ? () => stopCerveauRun(true)
                : startCerveauSend
            }
            disabled={cerveauPhase !== "sending" && !cerveauAnalyzed}
          >
            {cerveauPhase === "sending" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {cerveauPhase === "sending"
              ? t("settings.cerveauStopSend")
              : t("settings.cerveauSend", {
                  count: String(cerveauBf?.eligible ?? 0),
                })}
          </Button>
        </div>

        {cerveauStatus?.backfill.error && (
          <p className="text-sm text-destructive">{cerveauStatus.backfill.error}</p>
        )}
      </div>
    </div>
  );
}
