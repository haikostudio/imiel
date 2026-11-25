"use client";

import { useEffect, useCallback } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { users, getCurrentUserId, type UserSettings } from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { sendAction } from "@/lib/ws-channel";
import { t as tStatic } from "@/lib/i18n";
import { isSenderGrouped, mergeSendersIntoGroup, removeSenderGroup } from "@/lib/utils/sender-grouping";

// Delai (secondes) avant qu'un mail ouvert bascule en "lu". 0 = immediat.
// Les comptes qui n'ont JAMAIS choisi de valeur (champ vide ou 0 herite de
// l'ancien defaut) sont repris une seule fois vers cette valeur, ce qui laisse
// ensuite un 0 choisi a la main faire son effet.
export const DEFAULT_AUTO_MARK_READ_SECONDS = 5;

export type UiScale = "small" | "medium" | "large";
export type Density = "compact" | "comfortable" | "spacious";
/** Apparence de l'application : Miel (defaut) ou Minimaliste (noir et blanc d'origine). */
export type Design = "miel" | "minimal";
/** Fond illustre de l'apparence Miel. */
export type DesignBackground = "vagues" | "alveoles" | "matin" | "uni";
export const DESIGN_BACKGROUNDS: DesignBackground[] = ["vagues", "alveoles", "matin", "uni"];

// Cles du cache local relu par le script de demarrage (app/layout.tsx) pour
// poser data-design / data-design-bg AVANT le premier affichage.
const DESIGN_KEY = "imiel:design";
const DESIGN_BG_KEY = "imiel:designBg";

export function normalizeDesign(v: unknown): Design {
  return v === "minimal" ? "minimal" : "miel";
}

export function normalizeDesignBackground(v: unknown): DesignBackground {
  return DESIGN_BACKGROUNDS.includes(v as DesignBackground) ? (v as DesignBackground) : "vagues";
}

function readInitialDesign(): Design {
  if (typeof window === "undefined") return "miel";
  try { return normalizeDesign(localStorage.getItem(DESIGN_KEY)); } catch { return "miel"; }
}

function readInitialDesignBackground(): DesignBackground {
  if (typeof window === "undefined") return "vagues";
  try { return normalizeDesignBackground(localStorage.getItem(DESIGN_BG_KEY)); } catch { return "vagues"; }
}

/** Pose l'apparence sur <html> (les jetons CSS suivent) et la garde en cache local. */
export function applyDesign(design: Design, background: DesignBackground) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.design = design;
  root.dataset.designBg = background;
  try {
    localStorage.setItem(DESIGN_KEY, design);
    localStorage.setItem(DESIGN_BG_KEY, background);
  } catch {}
}

/** Change l'apparence tout de suite (sans recharger) et l'enregistre sur le compte. */
export async function setDesign(design: Design, background?: DesignBackground) {
  const state = useSettingsStore.getState();
  const prev = { design: state.design, designBackground: state.designBackground };
  const bg = background ?? state.designBackground;
  applyDesign(design, bg);
  state.load({ design, designBackground: bg });
  const userId = getCurrentUserId();
  if (!userId) return;
  try {
    await users().update(userId, { design, design_background: bg });
  } catch {
    applyDesign(prev.design, prev.designBackground);
    useSettingsStore.getState().load(prev);
  }
}

interface SettingsState {
  theme: "light" | "dark" | "system";
  design: Design;
  designBackground: DesignBackground;
  density: Density;
  uiScale: UiScale;
  previewLines: number;
  readingPane: "right" | "bottom" | "off";
  conversationView: boolean;
  autoMarkReadSeconds: number;
  defaultReplyAll: boolean;
  autoSaveInterval: number;
  language: string;
  blockedSenders: string[];
  groupedSenders: string[];
  loaded: boolean;
}

interface SettingsActions {
  load: (settings: Partial<SettingsState>) => void;
  setLoaded: (loaded: boolean) => void;
}

function readInitialUiScale(): UiScale {
  if (typeof window === "undefined") return "small";
  const v = localStorage.getItem("imiel:uiScale");
  return v === "medium" || v === "large" ? v : "small";
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  theme: "system",
  design: readInitialDesign(),
  designBackground: readInitialDesignBackground(),
  density: "comfortable",
  uiScale: readInitialUiScale(),
  previewLines: 2,
  readingPane: "right",
  conversationView: true,
  autoMarkReadSeconds: DEFAULT_AUTO_MARK_READ_SECONDS,
  defaultReplyAll: false,
  autoSaveInterval: 10,
  language: "fr",
  blockedSenders: [],
  groupedSenders: [],
  loaded: false,

  load: (settings) => set((state) => {
    const changed = !state.loaded || Object.entries(settings).some(
      ([key, value]) => (state as unknown as Record<string, unknown>)[key] !== value
    );
    if (!changed) return state;
    return { ...state, ...settings, loaded: true };
  }),
  setLoaded: (loaded) => set({ loaded }),
}));

export function applyUiScale(scale: UiScale) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.uiScale = scale;
}

export function applyTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  }
}

// Dedup du fetch settings : tous les composants qui appellent useSettings()
// (AuthenticatedLayout, page, MessageList, FilterBar, et chaque MessageRow)
// montent en meme temps avec store.loaded=false et declenchaient chacun un
// refresh() => ~12 GET /users/records/{id} identiques au boot (thundering
// herd) qui congestionnaient le main thread et retardaient la liste de mails.
// On partage une seule promesse in-flight au niveau module.
let settingsRefreshInFlight: Promise<void> | null = null;

export function useSettings() {
  const store = useSettingsStore();

  const refresh = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;
    if (settingsRefreshInFlight) return settingsRefreshInFlight;

    settingsRefreshInFlight = (async () => {
    try {
      const result = await users().getOne<UserSettings>(userId);
      const settings: Partial<SettingsState> = {
        theme: result.theme ?? "system",
        // Champ absent (migration 079 pas encore appliquee sur le serveur) :
        // on garde le choix local plutot que de le ramener a Miel.
        design: result.design === undefined ? readInitialDesign() : normalizeDesign(result.design),
        designBackground: result.design_background === undefined
          ? readInitialDesignBackground()
          : normalizeDesignBackground(result.design_background),
        density: result.density ?? "comfortable",
        uiScale: (result.ui_scale as UiScale) ?? readInitialUiScale(),
        previewLines: result.preview_lines ?? 2,
        readingPane: result.reading_pane ?? "right",
        conversationView: result.conversation_view ?? true,
        autoMarkReadSeconds: result.auto_mark_read_seconds ?? DEFAULT_AUTO_MARK_READ_SECONDS,
        defaultReplyAll: result.default_reply_all ?? false,
        autoSaveInterval: result.auto_save_interval ?? 10,
        language: result.language ?? "fr",
        blockedSenders: result.blocked_senders ?? [],
        groupedSenders: result.grouped_senders ?? [],
      };
      // Fallback localStorage si le champ PB n'existe pas encore (migration non appliquee)
      if ((!settings.groupedSenders || settings.groupedSenders.length === 0) && typeof window !== "undefined") {
        try {
          const local = localStorage.getItem("imiel:groupedSenders");
          if (local) settings.groupedSenders = JSON.parse(local);
        } catch {}
      }
      // Reprise unique vers les 5 secondes : un compte qui n'a jamais touche au
      // reglage (valeur absente ou 0) recoit la nouvelle valeur par defaut, une
      // seule fois et par utilisateur. Une valeur deja choisie n'est jamais
      // ecrasee, et apres la reprise un 0 volontaire est respecte.
      const migratedKey = `imiel:autoMarkRead5:${userId}`;
      let alreadyMigrated = true;
      try { alreadyMigrated = localStorage.getItem(migratedKey) === "1"; } catch {}
      if (!alreadyMigrated) {
        try { localStorage.setItem(migratedKey, "1"); } catch {}
        if (!result.auto_mark_read_seconds) {
          settings.autoMarkReadSeconds = DEFAULT_AUTO_MARK_READ_SECONDS;
          try {
            await users().update(userId, { auto_mark_read_seconds: DEFAULT_AUTO_MARK_READ_SECONDS });
          } catch {}
        }
      }
      useSettingsStore.getState().load(settings);
      const theme = settings.theme as "light" | "dark" | "system";
      applyTheme(theme);
      localStorage.setItem("theme", theme);
      applyDesign(settings.design ?? "miel", settings.designBackground ?? "vagues");
      if (settings.uiScale) {
        applyUiScale(settings.uiScale);
        try { localStorage.setItem("imiel:uiScale", settings.uiScale); } catch {}
      }
    } catch {
      useSettingsStore.getState().setLoaded(true);
    }
    })().finally(() => {
      settingsRefreshInFlight = null;
    });
    return settingsRefreshInFlight;
  }, []);

  // Chargement initial : appliquer localStorage en attendant PocketBase
  useEffect(() => {
    if (!store.loaded) {
      const saved = localStorage.getItem("theme") as "light" | "dark" | null;
      if (saved) {
        applyTheme(saved);
      }
      applyUiScale(readInitialUiScale());
      applyDesign(readInitialDesign(), readInitialDesignBackground());
      refresh();
    }
  }, [store.loaded, refresh]);

  // Ecouter prefers-color-scheme si theme = system
  useEffect(() => {
    if (store.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.classList.toggle("dark", e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [store.theme]);

  // Ecouter l'evenement custom pour refresh apres sauvegarde
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("settings-updated", handler);
    return () => window.removeEventListener("settings-updated", handler);
  }, [refresh]);

  return {
    ...store,
    refresh,
  };
}

/** Notifier les composants que les settings ont change */
export function notifySettingsUpdated() {
  window.dispatchEvent(new Event("settings-updated"));
}

/** Bloquer un expediteur et persister dans PocketBase */
export async function blockSender(email: string) {
  const current = useSettingsStore.getState().blockedSenders;
  if (current.includes(email)) return;
  const updated = [...current, email];
  useSettingsStore.getState().load({ blockedSenders: updated });

  // Retrait optimiste ANIME de tous les messages de cet expediteur dans les
  // listes ouvertes (le serveur les filtrera via blocked_senders au prochain
  // fetch). Propage aussi aux autres onglets via le hub WS.
  useMailStore.getState().notifySenderRemoval(email);
  sendAction({ action: "sender-removal", email });

  const userId = getCurrentUserId();
  const persist = (async () => {
    if (!userId) return;
    try {
      await users().update(userId, { blocked_senders: updated });
    } catch {
      useSettingsStore.getState().load({ blockedSenders: current });
      // Les messages ont ete retires optimistiquement : re-fetch pour les remontrer
      useMailStore.getState().invalidateMessages();
    }
  })();

  toast.success(tStatic("message.senderBlocked"), {
    duration: 6000,
    action: {
      label: tStatic("undo"),
      onClick: async () => {
        // Attend la persistance du blocage avant de le renverser (evite la course)
        await persist;
        void unblockSender(email);
      },
    },
  });

  await persist;
}

/** Debloquer un expediteur et persister dans PocketBase */
export async function unblockSender(email: string) {
  const current = useSettingsStore.getState().blockedSenders;
  const updated = current.filter((e) => e !== email);
  useSettingsStore.getState().load({ blockedSenders: updated });
  toast.success(tStatic("message.senderUnblocked"));

  const userId = getCurrentUserId();
  if (userId) {
    try {
      await users().update(userId, { blocked_senders: updated });
      // Les messages de cet expediteur redeviennent visibles : re-fetch des listes
      useMailStore.getState().invalidateMessages();
    } catch {
      useSettingsStore.getState().load({ blockedSenders: current });
    }
  }
}

/** Persister groupedSenders en localStorage (fallback si PB migration non appliquee) */
function persistGroupedSendersLocal(senders: string[]) {
  try { localStorage.setItem("imiel:groupedSenders", JSON.stringify(senders)); } catch {}
}

/** Ajouter un expediteur a la liste de groupement et persister dans PocketBase + localStorage */
export async function groupSender(email: string) {
  if (isSenderGrouped(useSettingsStore.getState().groupedSenders, email)) return;
  await groupSenders([email]);
}

/**
 * Reunir plusieurs adresses en UN groupe (bouton "Regrouper"). Un groupe
 * existant qui contient deja l'une d'elles est complete plutot que duplique.
 */
export async function groupSenders(emails: string[]) {
  const current = useSettingsStore.getState().groupedSenders;
  const updated = mergeSendersIntoGroup(current, emails);
  if (updated.length === current.length && updated.every((e, i) => e === current[i])) return;
  useSettingsStore.getState().load({ groupedSenders: updated });
  persistGroupedSendersLocal(updated);

  const userId = getCurrentUserId();
  if (userId) {
    try {
      await users().update(userId, { grouped_senders: updated });
    } catch {
      // PB field may not exist yet — localStorage fallback already saved
    }
  }
}

/** Defaire le groupe qui contient cet expediteur (toutes ses adresses) et persister */
export async function ungroupSender(email: string) {
  const current = useSettingsStore.getState().groupedSenders;
  const updated = removeSenderGroup(current, email);
  useSettingsStore.getState().load({ groupedSenders: updated });
  persistGroupedSendersLocal(updated);

  const userId = getCurrentUserId();
  if (userId) {
    try {
      await users().update(userId, { grouped_senders: updated });
    } catch {
      // PB field may not exist yet — localStorage fallback already saved
    }
  }
}

/** Toggle le theme (light <-> dark) et persiste dans PocketBase + localStorage */
export async function toggleTheme() {
  const root = document.documentElement;
  const newDark = !root.classList.contains("dark");
  const newTheme = newDark ? "dark" : "light";

  // 1. Appliquer immediatement
  root.classList.toggle("dark", newDark);
  localStorage.setItem("theme", newTheme);
  useSettingsStore.getState().load({ theme: newTheme });

  // 2. Persister dans PocketBase (best-effort)
  const userId = getCurrentUserId();
  if (userId) {
    try {
      await users().update(userId, { theme: newTheme });
    } catch {
      // Silently fail - localStorage is our fallback
    }
  }
}

/** Vrai quand l'apparence Miel est active (pilote les variantes de mise en page). */
export function useIsMiel(): boolean {
  return useSettingsStore((s) => s.design === "miel");
}

/** Changer la densite de la liste et persister dans PocketBase */
export async function setDensity(density: Density) {
  const previous = useSettingsStore.getState().density;
  if (previous === density) return;

  useSettingsStore.getState().load({ density });

  const userId = getCurrentUserId();
  if (userId) {
    try {
      await users().update(userId, { density });
    } catch {
      useSettingsStore.getState().load({ density: previous });
    }
  }
}
