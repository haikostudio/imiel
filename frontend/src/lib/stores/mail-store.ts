import { create } from "zustand";
import type { Message } from "@/lib/pocketbase";
import type { DraftData, SavedAttachment } from "@/lib/hooks/useAutoSave";
import { cancelPendingMarkRead } from "@/lib/mark-read-timer";

export type FolderType =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "spam"
  | "archive"
  | "custom"
  | "starred"
  | "all_mail"
  | "unread"
  | "label";

// Duree de l'animation de sortie d'une ligne (doit matcher
// .animate-message-slide-out dans globals.css)
export const REMOVAL_ANIM_MS = 300;

export interface ListFilter {
  unread: boolean;
  hasAttachments: boolean;
  starred: boolean;
  priority: "all" | "high" | "normal" | "low";
  fromText: string;
  bodyText: string;
  /** Pastille de niveau (tri en trois niveaux) : null = tous les niveaux. */
  importance: MailImportance | null;
}

export type MailImportance = "important" | "secondary" | "low";

const DEFAULT_LIST_FILTER: ListFilter = {
  unread: false,
  hasAttachments: false,
  starred: false,
  priority: "all",
  fromText: "",
  bodyText: "",
  importance: null,
};

export type ComposeMode = "new" | "reply" | "reply-all" | "forward" | "edit";

export interface ComposeInstance {
  id: string;
  mode: ComposeMode;
  replyToMessageId: string | null;
  minimized: boolean;
  initialTo: string | null;
  titleLabel?: string;
}

// --- localStorage persistence helpers ---

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return JSON.parse(stored) as T;
  } catch {
    // ignore
  }
  return fallback;
}

function saveToStorage(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

let composeIdCounter = 0;
function generateComposeId(): string {
  return `compose-${++composeIdCounter}-${Date.now().toString(36)}`;
}

// Geste de fermeture du fil enregistre par la page mail (hors state : c'est une
// fonction, elle ne doit declencher aucun rendu).
let closeThreadHandler: (() => void) | null = null;

const STORAGE_KEY_SIDEBAR = "imiel:sidebarCollapsed";
const STORAGE_KEY_AICHAT = "imiel:aiChatOpen";
const STORAGE_KEY_COMPOSE = "imiel:composeState";
export const STORAGE_KEY_SELECTION = "imiel:selectedMessage";
// Les IDs hybrides de la recherche courante survivent au refresh (sessionStorage,
// borne a l'onglet) : sinon, en rechargeant la vue "voir tout" (/mail/x?q=...),
// le store repart vide et la liste retombe sur les conversations par defaut du
// dossier au lieu des resultats de recherche.
const STORAGE_KEY_SEARCH_HYBRID = "imiel:searchHybridIds";

function loadSearchHybridIds(): { query: string; ids: string[] } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_SEARCH_HYBRID);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.query === "string" && Array.isArray(parsed.ids)) {
        return parsed as { query: string; ids: string[] };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function saveSearchHybridIds(value: { query: string; ids: string[] } | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY_SEARCH_HYBRID, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY_SEARCH_HYBRID);
  } catch {
    // ignore
  }
}

function loadComposeInstances(): ComposeInstance[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY_COMPOSE);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Nouveau format : tableau d'instances
      if (Array.isArray(parsed.composeInstances)) {
        // Ne restaurer que les instances qui ont un brouillon PB a charger (mode edit)
        // Les instances "new", "reply", "forward" n'ont pas de contenu persistable
        // et apparaitraient vides au rechargement
        const restorable = parsed.composeInstances.filter(
          (inst: ComposeInstance) => inst.mode === "edit" && inst.replyToMessageId
        );
        if (restorable.length !== parsed.composeInstances.length) {
          saveToStorage(STORAGE_KEY_COMPOSE, { composeInstances: restorable });
        }
        return restorable;
      }
      // Ancien format : migration
      if (parsed.composeOpen) {
        return [{
          id: generateComposeId(),
          mode: parsed.composeMode || "new",
          replyToMessageId: parsed.replyToMessageId || null,
          minimized: parsed.composeMinimized || false,
          initialTo: null,
        }];
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function saveComposeInstances(instances: ComposeInstance[]): void {
  saveToStorage(STORAGE_KEY_COMPOSE, { composeInstances: instances });
}

interface MailState {
  // Compte actif
  activeAccountId: string | "all" | null;
  // Dossier(s) actif(s) (IDs PocketBase — plusieurs si "tous les comptes")
  activeFolderIds: string[];
  // Type de dossier actif
  activeFolder: FolderType;
  // Message sélectionné
  selectedMessageId: string | null;
  // Thread sélectionné
  selectedThreadId: string | null;
  // Message a surligner dans la vue thread (saut depuis un resultat de recherche).
  // Distinct de selectedMessageId (qui vaut le plus souvent le dernier message du
  // thread) : ne contient que le message qui a matche la requete, pour le scroll
  // et le highlight temporaire. null hors recherche.
  searchMatchMessageId: string | null;
  // Verrou : timestamp jusqu'auquel la selection est protegee contre les overrides automatiques
  _selectionLockedUntil: number;
  // Recherche
  searchQuery: string;
  searchOpen: boolean;
  // IDs retournes par le moteur hybride (semantique + FTS5) pour la query
  // courante. Permet a la vue principale (/mail/[folder]?q=...) de reutiliser
  // les memes resultats que la palette quand on clique "voir tout", sinon
  // la vue retomberait sur un LIKE PB limite a subject/from/to et perdrait
  // les matches sur le body (faux negatif "n'affiche rien").
  searchHybridIds: { query: string; ids: string[] } | null;
  // Composition multi-fenetres
  composeInstances: ComposeInstance[];
  focusedComposeId: string | null;
  // Instances de composition ayant du contenu saisi (id -> true). NON persiste :
  // sert a eviter d'empiler plusieurs fenetres "Nouveau message" VIDES. Une
  // instance absente de la map est consideree vide (fraichement ouverte).
  composeContentIds: Record<string, boolean>;
  // Sidebar
  sidebarCollapsed: boolean;
  // Panneau chat IA (sidebar droite)
  aiChatOpen: boolean;
  // Largeur (px) du panneau chat IA sur desktop : les fenetres de composition
  // se rangent a sa gauche quand il est ouvert.
  aiChatWidth: number;
  // Draft auto-save status
  draftSaving: boolean;
  draftLastSaved: Date | null;
  // Cle de rafraichissement pour forcer le re-fetch des messages/threads
  messagesRefreshKey: number;
  // Cle de rafraichissement pour forcer le re-fetch des dossiers (compteurs)
  foldersRefreshKey: number;
  // Signal pour fetch incremental (nouveaux messages seulement, pas de full refresh)
  newMessagesSignal: number;
  // Notification locale de mise a jour d'un message (bus d'evenements)
  localMessageUpdate: { id: string; changes: Partial<Message>; ts: number } | null;
  // Notification locale d'insertion de message (brouillon cree)
  localMessageInsert: { message: Partial<Message> & { id: string; date: string }; ts: number } | null;
  // Notification locale de retrait de message(s) (optimistic removal)
  localMessageRemoval: { ids: string[]; ts: number } | null;
  // Notification locale de retrait de tous les messages d'un expediteur (blocage)
  localSenderRemoval: { email: string; ts: number } | null;
  // Ids des messages en cours d'animation de sortie (slide-out avant purge)
  removingMessageIds: Set<string>;
  // Filter rule dialog
  filterRuleOpen: boolean;
  filterRuleMessage: Message | null;
  // Filtres de liste
  listFilter: ListFilter;
  // Selection multiple (checkboxes)
  checkedIds: Set<string>;
  // Sync brouillons : mise a jour de contenu
  draftContentUpdate: {
    draftId: string;
    data: DraftData;
    attachments?: SavedAttachment[];
    fromAccountId?: string;
    sourceId: string;
    ts: number;
  } | null;
  // Sync brouillons : evenement de cycle de vie
  draftLifecycleEvent: {
    draftId: string;
    event: "deleted" | "sent";
    sourceId: string;
    ts: number;
  } | null;
  // Signal quand un brouillon avec thread_id est cree/supprime (pour le badge)
  draftThreadSignal: { threadId: string; action: "add" | "remove"; ts: number } | null;
  // Compteurs sidebar (source de verite = serveur, ajustes optimistement)
  sidebarCounts: SidebarCounts;
  // Vue par label (filtre cross-folders)
  activeLabelId: string | null;
  // IDs des labels marques comme "secondaires" : leurs mails sortent de l'inbox.
  // Source de verite = champ Label.is_secondary cote serveur, miroir local ici
  // pour garantir un re-render synchrone sur toggle (useMailStore est subscribe
  // par tous les hooks de liste, donc le filtre s'applique instantanement).
  secondaryLabelIds: string[];
}

export interface SidebarCounts {
  inboxUnread: number;
  inboxTotal: number;
  starred: number;
  unread: number;
  sent: number;
  drafts: number;
  trash: number;
  allMail: number;
  /** Non lus des 30 derniers jours (badge de "Tous les messages"). */
  allMailUnread30?: number;
  spam: number;
}

interface MailActions {
  setActiveAccount: (accountId: string | "all" | null) => void;
  setActiveFolder: (folderIds: string[], folderType?: FolderType) => void;
  setActiveLabel: (labelId: string | null) => void;
  selectMessage: (messageId: string | null, threadId?: string | null, userInitiated?: boolean) => void;
  setSearchMatch: (messageId: string | null) => void;
  lockSelection: () => void;
  // Fermeture de la conversation ouverte. La page mail enregistre SON geste de
  // fermeture (celui de la croix : deselection + nettoyage de l'adresse) ;
  // toute action qui doit refermer le fil (blocage, marquage non lu) passe par
  // requestCloseThread et obtient exactement le meme resultat, mobile compris.
  registerCloseThread: (fn: (() => void) | null) => void;
  requestCloseThread: () => void;
  openCompose: (mode?: ComposeMode, replyToMessageId?: string | null, initialTo?: string | null) => void;
  closeCompose: (instanceId?: string) => void;
  minimizeCompose: (instanceId?: string) => void;
  toggleComposeMinimized: (instanceId?: string) => void;
  updateComposeTitleLabel: (instanceId: string, titleLabel: string) => void;
  focusCompose: (instanceId: string) => void;
  setComposeHasContent: (instanceId: string, hasContent: boolean) => void;
  toggleSidebar: () => void;
  toggleAiChat: () => void;
  setAiChatOpen: (open: boolean) => void;
  setAiChatWidth: (width: number) => void;
  openSearch: () => void;
  closeSearch: () => void;
  setSearchQuery: (query: string) => void;
  setSearchHybridIds: (query: string, ids: string[]) => void;
  clearSearchHybridIds: () => void;
  setDraftSaveStatus: (saving: boolean, lastSaved?: Date | null) => void;
  invalidateMessages: () => void;
  invalidateFolders: () => void;
  signalNewMessages: () => void;
  notifyMessageUpdate: (id: string, changes: Partial<Message>) => void;
  notifyMessageInsert: (message: Partial<Message> & { id: string; date: string }) => void;
  notifyMessageRemoval: (ids: string | string[]) => void;
  notifySenderRemoval: (email: string) => void;
  markMessagesRemoving: (ids: string[]) => void;
  unmarkMessagesRemoving: (ids: string[]) => void;
  openFilterRule: (message: Message) => void;
  closeFilterRule: () => void;
  setListFilter: (filter: Partial<ListFilter>) => void;
  clearListFilter: () => void;
  toggleChecked: (id: string) => void;
  checkAll: (ids: string[]) => void;
  uncheckAll: () => void;
  notifyDraftContentUpdate: (draftId: string, data: DraftData, sourceId: string, attachments?: SavedAttachment[], fromAccountId?: string) => void;
  notifyDraftLifecycle: (draftId: string, event: "deleted" | "sent", sourceId: string) => void;
  notifyDraftThread: (threadId: string, action: "add" | "remove") => void;
  setSidebarCounts: (counts: SidebarCounts) => void;
  adjustSidebarCount: (key: keyof SidebarCounts, delta: number) => void;
  setSecondaryLabelIds: (ids: string[]) => void;
  /** Toggle un label entre primaire/secondaire et retourne le nouvel etat. */
  toggleSecondaryLabel: (id: string) => boolean;
}

export type MailStore = MailState & MailActions;

const initialInstances = loadComposeInstances();

export const useMailStore = create<MailStore>((set, get) => ({
  // State initial
  activeAccountId: null,
  activeFolderIds: [],
  activeFolder: "all_mail",
  activeLabelId: null,
  selectedMessageId: null,
  selectedThreadId: null,
  searchMatchMessageId: null,
  _selectionLockedUntil: 0,
  searchQuery: "",
  searchOpen: false,
  searchHybridIds: loadSearchHybridIds(),
  composeInstances: initialInstances,
  focusedComposeId: initialInstances.length > 0 ? initialInstances[initialInstances.length - 1].id : null,
  composeContentIds: {},
  sidebarCollapsed: loadFromStorage(STORAGE_KEY_SIDEBAR, false),
  aiChatOpen: loadFromStorage(STORAGE_KEY_AICHAT, false),
  aiChatWidth: 400,
  draftSaving: false,
  draftLastSaved: null,
  messagesRefreshKey: 0,
  foldersRefreshKey: 0,
  newMessagesSignal: 0,
  localMessageUpdate: null,
  localMessageInsert: null,
  localMessageRemoval: null,
  localSenderRemoval: null,
  removingMessageIds: new Set<string>(),
  filterRuleOpen: false,
  filterRuleMessage: null,
  listFilter: DEFAULT_LIST_FILTER,
  checkedIds: new Set<string>(),
  draftContentUpdate: null,
  draftLifecycleEvent: null,
  draftThreadSignal: null,
  sidebarCounts: { inboxUnread: 0, inboxTotal: 0, starred: 0, unread: 0, sent: 0, drafts: 0, trash: 0, allMail: 0, spam: 0 },
  secondaryLabelIds: [],

  // Actions
  setActiveAccount: (accountId) =>
    set({
      activeAccountId: accountId,
      selectedMessageId: null,
      selectedThreadId: null,
      checkedIds: new Set<string>(),
    }),

  setActiveFolder: (folderIds, folderType) => {
    const state = get();
    const newType = folderType ?? state.activeFolder;
    const sameIds =
      state.activeFolderIds.length === folderIds.length &&
      (state.activeFolderIds.length === 0 ||
        (state.activeFolderIds.length === 1
          ? state.activeFolderIds[0] === folderIds[0]
          : (() => { const s = new Set(state.activeFolderIds); return folderIds.every((id) => s.has(id)); })()));
    if (sameIds && state.activeFolder === newType && state.activeLabelId === null) return;
    const locked = state._selectionLockedUntil > Date.now();
    set({
      activeFolderIds: folderIds,
      activeFolder: newType,
      activeLabelId: null,
      selectedMessageId: locked ? state.selectedMessageId : null,
      selectedThreadId: locked ? state.selectedThreadId : null,
      listFilter: locked ? state.listFilter : DEFAULT_LIST_FILTER,
      checkedIds: locked ? state.checkedIds : new Set<string>(),
    });
  },

  setActiveLabel: (labelId) => {
    const state = get();
    if (state.activeLabelId === labelId && state.activeFolder === "label") return;
    set({
      activeLabelId: labelId,
      activeFolder: "label",
      activeFolderIds: [],
      selectedMessageId: null,
      selectedThreadId: null,
      listFilter: DEFAULT_LIST_FILTER,
      checkedIds: new Set<string>(),
    });
  },

  selectMessage: (messageId, threadId, userInitiated) => {
    const state = get();
    // Si la selection est verrouillee (clic utilisateur recent), ignorer les overrides automatiques
    if (!userInitiated && state._selectionLockedUntil > Date.now()) return;
    if (messageId) {
      saveToStorage(STORAGE_KEY_SELECTION, { messageId, threadId: threadId ?? null });
    } else {
      saveToStorage(STORAGE_KEY_SELECTION, null);
    }
    set({
      selectedMessageId: messageId,
      selectedThreadId: threadId ?? null,
    });
  },

  setSearchMatch: (messageId) => set({ searchMatchMessageId: messageId }),

  lockSelection: () => {
    set({ _selectionLockedUntil: Date.now() + 3000 });
  },

  registerCloseThread: (fn) => {
    closeThreadHandler = fn;
  },

  requestCloseThread: () => {
    // Un fil qu'on referme ne doit jamais basculer en lu apres coup.
    cancelPendingMarkRead();
    if (closeThreadHandler) {
      closeThreadHandler();
      return;
    }
    // Repli quand aucune page mail n'est montee (route conversation dediee,
    // fiche contact...) : la deselection suffit, il n'y a pas d'adresse a nettoyer.
    get().selectMessage(null, null, true);
  },

  openCompose: (mode = "new", replyToMessageId = null, initialTo = null) => {
    const state = get();

    // Eviter les doublons : edition de brouillon ET reponse/transfert d'un
    // meme message (sinon chaque clic sur Repondre empile une fenetre
    // identique). On refocalise / restaure la fenetre existante a la place.
    if (replyToMessageId && mode !== "new") {
      const existing = state.composeInstances.find(
        (inst) => inst.mode === mode && inst.replyToMessageId === replyToMessageId
      );
      if (existing) {
        if (existing.minimized) {
          const instances = state.composeInstances.map((inst) =>
            inst.id === existing.id ? { ...inst, minimized: false } : inst
          );
          saveComposeInstances(instances);
          set({ composeInstances: instances, focusedComposeId: existing.id });
        } else {
          set({ focusedComposeId: existing.id });
        }
        return;
      }
    }

    // Eviter d'empiler plusieurs fenetres "Nouveau message" VIDES : si une
    // fenetre "new" (meme destinataire initial) est deja ouverte et encore
    // vide, on la refocalise/restaure au lieu d'en creer une autre. Des qu'elle
    // recoit du contenu (composeContentIds), un nouveau clic ouvre bien une
    // nouvelle fenetre : les brouillons DISTINCTS restent autorises.
    if (mode === "new") {
      const emptyExisting = state.composeInstances.find(
        (inst) =>
          inst.mode === "new" &&
          (inst.initialTo ?? null) === (initialTo ?? null) &&
          !state.composeContentIds[inst.id]
      );
      if (emptyExisting) {
        if (emptyExisting.minimized) {
          const instances = state.composeInstances.map((inst) =>
            inst.id === emptyExisting.id ? { ...inst, minimized: false } : inst
          );
          saveComposeInstances(instances);
          set({ composeInstances: instances, focusedComposeId: emptyExisting.id });
        } else {
          set({ focusedComposeId: emptyExisting.id });
        }
        return;
      }
    }

    const newInstance: ComposeInstance = {
      id: generateComposeId(),
      mode,
      replyToMessageId,
      minimized: false,
      initialTo,
    };

    const instances = [...state.composeInstances, newInstance];
    saveComposeInstances(instances);
    set({ composeInstances: instances, focusedComposeId: newInstance.id });
  },

  closeCompose: (instanceId?: string) => {
    const state = get();
    let instances: ComposeInstance[];

    if (instanceId) {
      instances = state.composeInstances.filter((inst) => inst.id !== instanceId);
    } else {
      // Fermer la derniere instance
      instances = state.composeInstances.slice(0, -1);
    }

    saveComposeInstances(instances);
    const closedId = instanceId ?? state.composeInstances[state.composeInstances.length - 1]?.id;
    const newFocused = state.focusedComposeId === closedId
      ? (instances.length > 0 ? instances[instances.length - 1].id : null)
      : state.focusedComposeId;
    let composeContentIds = state.composeContentIds;
    if (closedId && composeContentIds[closedId]) {
      composeContentIds = { ...composeContentIds };
      delete composeContentIds[closedId];
    }
    set({ composeInstances: instances, focusedComposeId: newFocused, composeContentIds });
  },

  minimizeCompose: (instanceId?: string) => {
    set((state) => {
      const instances = state.composeInstances.map((inst) => {
        if (instanceId ? inst.id === instanceId : inst === state.composeInstances[state.composeInstances.length - 1]) {
          return { ...inst, minimized: true };
        }
        return inst;
      });
      saveComposeInstances(instances);
      return { composeInstances: instances };
    });
  },

  toggleComposeMinimized: (instanceId?: string) =>
    set((state) => {
      const instances = state.composeInstances.map((inst) => {
        if (instanceId ? inst.id === instanceId : inst === state.composeInstances[state.composeInstances.length - 1]) {
          return { ...inst, minimized: !inst.minimized };
        }
        return inst;
      });
      saveComposeInstances(instances);
      return { composeInstances: instances };
    }),

  updateComposeTitleLabel: (instanceId: string, titleLabel: string) => {
    set((state) => {
      const instances = state.composeInstances.map((inst) =>
        inst.id === instanceId ? { ...inst, titleLabel } : inst
      );
      saveComposeInstances(instances);
      return { composeInstances: instances };
    });
  },

  focusCompose: (instanceId: string) => set({ focusedComposeId: instanceId }),

  setComposeHasContent: (instanceId: string, hasContent: boolean) => {
    set((state) => {
      const current = !!state.composeContentIds[instanceId];
      if (current === hasContent) return {};
      const next = { ...state.composeContentIds };
      if (hasContent) next[instanceId] = true;
      else delete next[instanceId];
      return { composeContentIds: next };
    });
  },

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      saveToStorage(STORAGE_KEY_SIDEBAR, next);
      return { sidebarCollapsed: next };
    }),

  toggleAiChat: () =>
    set((state) => {
      const next = !state.aiChatOpen;
      saveToStorage(STORAGE_KEY_AICHAT, next);
      return { aiChatOpen: next };
    }),

  setAiChatOpen: (open) => {
    saveToStorage(STORAGE_KEY_AICHAT, open);
    set({ aiChatOpen: open });
  },

  setAiChatWidth: (width) => set({ aiChatWidth: width }),

  openSearch: () => set({ searchOpen: true }),

  closeSearch: () => set({ searchOpen: false, searchQuery: "" }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchHybridIds: (query, ids) => {
    const value = { query, ids };
    saveSearchHybridIds(value);
    set({ searchHybridIds: value });
  },

  clearSearchHybridIds: () => {
    saveSearchHybridIds(null);
    set({ searchHybridIds: null });
  },

  setDraftSaveStatus: (saving, lastSaved) =>
    set({
      draftSaving: saving,
      ...(lastSaved !== undefined ? { draftLastSaved: lastSaved } : {}),
    }),

  invalidateMessages: () =>
    set((state) => ({ messagesRefreshKey: state.messagesRefreshKey + 1 })),

  invalidateFolders: () =>
    set((state) => ({ foldersRefreshKey: state.foldersRefreshKey + 1 })),

  signalNewMessages: () =>
    set((state) => ({ newMessagesSignal: state.newMessagesSignal + 1 })),

  notifyMessageUpdate: (id, changes) =>
    set({ localMessageUpdate: { id, changes, ts: Date.now() } }),

  notifyMessageInsert: (message) =>
    set({ localMessageInsert: { message, ts: Date.now() } }),

  // Retrait en deux phases : marquer les lignes "en cours de suppression"
  // (animation slide-out) puis purger les donnees apres l'animation.
  notifyMessageRemoval: (ids) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    get().markMessagesRemoving(arr);
    setTimeout(() => {
      set((state) => {
        const next = new Set(state.removingMessageIds);
        for (const id of arr) next.delete(id);
        return {
          removingMessageIds: next,
          localMessageRemoval: { ids: arr, ts: Date.now() },
        };
      });
    }, REMOVAL_ANIM_MS);
  },

  // Retrait de TOUS les messages d'un expediteur (blocage) : les hooks de
  // listing (useMessages/useThreads) resolvent les ids concernes, jouent
  // l'animation puis purgent leurs donnees.
  notifySenderRemoval: (email) =>
    set({ localSenderRemoval: { email: email.toLowerCase().trim(), ts: Date.now() } }),

  markMessagesRemoving: (ids) =>
    set((state) => {
      const next = new Set(state.removingMessageIds);
      for (const id of ids) next.add(id);
      return { removingMessageIds: next };
    }),

  unmarkMessagesRemoving: (ids) =>
    set((state) => {
      if (ids.every((id) => !state.removingMessageIds.has(id))) return state;
      const next = new Set(state.removingMessageIds);
      for (const id of ids) next.delete(id);
      return { removingMessageIds: next };
    }),

  openFilterRule: (message) => set({ filterRuleOpen: true, filterRuleMessage: message }),
  closeFilterRule: () => set({ filterRuleOpen: false, filterRuleMessage: null }),

  setListFilter: (filter) =>
    set((state) => ({ listFilter: { ...state.listFilter, ...filter } })),
  clearListFilter: () => set({ listFilter: DEFAULT_LIST_FILTER }),

  toggleChecked: (id) =>
    set((state) => {
      const next = new Set(state.checkedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { checkedIds: next };
    }),
  checkAll: (ids) => set({ checkedIds: new Set(ids) }),
  uncheckAll: () => set({ checkedIds: new Set<string>() }),

  notifyDraftContentUpdate: (draftId, data, sourceId, attachments, fromAccountId) =>
    set({ draftContentUpdate: { draftId, data, attachments, fromAccountId, sourceId, ts: Date.now() } }),

  notifyDraftLifecycle: (draftId, event, sourceId) =>
    set({ draftLifecycleEvent: { draftId, event, sourceId, ts: Date.now() } }),

  notifyDraftThread: (threadId, action) =>
    set({ draftThreadSignal: { threadId, action, ts: Date.now() } }),

  setSidebarCounts: (counts) => set({ sidebarCounts: counts }),

  adjustSidebarCount: (key, delta) =>
    set((state) => ({
      sidebarCounts: {
        ...state.sidebarCounts,
        [key]: Math.max(0, (state.sidebarCounts[key] ?? 0) + delta),
      },
    })),

  setSecondaryLabelIds: (ids) => set({ secondaryLabelIds: ids }),

  toggleSecondaryLabel: (id) => {
    const has = get().secondaryLabelIds.includes(id);
    const next = !has;
    set((state) => ({
      secondaryLabelIds: has
        ? state.secondaryLabelIds.filter((x) => x !== id)
        : [...state.secondaryLabelIds, id],
    }));
    return next;
  },
}));
