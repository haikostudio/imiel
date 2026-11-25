import { create } from "zustand";

export interface SpamScanItem {
  id: number;
  subject: string;
  from: string;
  status: "recovered" | "kept";
}

export type AccountScanStatus = "pending" | "running" | "done" | "error";

export interface AccountScan {
  accountId: string;
  accountEmail: string;
  total: number;
  processed: number;
  recovered: number;
  items: SpamScanItem[];
  status: AccountScanStatus;
  error: string | null;
}

interface SpamScanState {
  open: boolean;
  running: boolean;
  accounts: AccountScan[];
  globalError: string | null;
}

interface SpamScanActions {
  begin: (accounts: { id: string; email: string }[]) => void;
  setAccountStart: (accountId: string, total: number, accountLabel?: string | null) => void;
  addItem: (accountId: string, item: Omit<SpamScanItem, "id">) => void;
  failAccount: (accountId: string, error: string) => void;
  finishAccount: (accountId: string) => void;
  finishAll: () => void;
  fail: (error: string) => void;
  close: () => void;
}

// Fenetre glissante par compte : evite une liste illimitee, les compteurs
// processed/recovered restent exacts.
const MAX_ITEMS_PER_ACCOUNT = 60;

let itemIdCounter = 0;

const initialState: SpamScanState = {
  open: false,
  running: false,
  accounts: [],
  globalError: null,
};

export const useSpamScanStore = create<SpamScanState & SpamScanActions>((set) => ({
  ...initialState,

  begin: (accounts) =>
    set({
      open: true,
      running: true,
      globalError: null,
      accounts: accounts.map((a) => ({
        accountId: a.id,
        accountEmail: a.email,
        total: 0,
        processed: 0,
        recovered: 0,
        items: [],
        status: "pending",
        error: null,
      })),
    }),

  setAccountStart: (accountId, total, accountLabel) =>
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.accountId === accountId
          ? {
              ...a,
              total: a.total + total,
              status: "running",
              accountEmail: accountLabel ?? a.accountEmail,
            }
          : a
      ),
    })),

  addItem: (accountId, item) =>
    set((s) => ({
      accounts: s.accounts.map((a) => {
        if (a.accountId !== accountId) return a;
        const next = [{ ...item, id: ++itemIdCounter }, ...a.items].slice(
          0,
          MAX_ITEMS_PER_ACCOUNT
        );
        return {
          ...a,
          items: next,
          processed: a.processed + 1,
          recovered: a.recovered + (item.status === "recovered" ? 1 : 0),
        };
      }),
    })),

  finishAccount: (accountId) =>
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.accountId === accountId && a.status !== "error"
          ? { ...a, status: "done" }
          : a
      ),
    })),

  failAccount: (accountId, error) =>
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.accountId === accountId ? { ...a, status: "error", error } : a
      ),
    })),

  finishAll: () => set({ running: false }),

  fail: (error) => set({ running: false, globalError: error }),

  close: () => set({ ...initialState }),
}));
