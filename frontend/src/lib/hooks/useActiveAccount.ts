"use client";

import { useEffect, useMemo } from "react";
import { useMailStore } from "@/lib/stores/mail-store";
import { useAccounts } from "@/lib/hooks/useAccounts";
import type { Account } from "@/lib/pocketbase";

const STORAGE_KEY = "imiel:activeAccountId";

interface UseActiveAccountReturn {
  activeAccount: Account | null;
  activeAccountId: string | "all" | null;
  setActiveAccount: (id: string | "all" | null) => void;
}

export function useActiveAccount(): UseActiveAccountReturn {
  const { accounts } = useAccounts();
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const setActiveAccount = useMailStore((s) => s.setActiveAccount);

  // Au montage, le defaut est "Tous les comptes" : on ne re-selectionne pas
  // automatiquement un compte deja persiste (l'utilisateur veut "Tous" actif a
  // chaque ouverture). SEULE exception : quand l'adresse porte explicitement une
  // boite (`?a=<compte>`, ecrit par le selecteur de comptes), on rouvre CETTE
  // boite -- c'est ce qui rend un lien partage et un rechargement fideles a
  // l'ecran qu'on avait sous les yeux.
  useEffect(() => {
    if (activeAccountId !== null) return;
    if (accounts.length === 0) return;
    const fromUrl = new URLSearchParams(
      (typeof window !== "undefined" ? window.location.hash.split("?")[1] : "") || ""
    ).get("a");
    if (fromUrl && fromUrl !== "all" && accounts.some((a) => a.id === fromUrl)) {
      setActiveAccount(fromUrl);
      return;
    }
    setActiveAccount("all");
  }, [accounts, activeAccountId, setActiveAccount]);

  // Persister le choix dans localStorage
  useEffect(() => {
    if (activeAccountId !== null) {
      localStorage.setItem(STORAGE_KEY, activeAccountId);
    }
  }, [activeAccountId]);

  const activeAccount = useMemo(() => {
    if (!activeAccountId || activeAccountId === "all") return null;
    return accounts.find((a) => a.id === activeAccountId) ?? null;
  }, [accounts, activeAccountId]);

  return { activeAccount, activeAccountId, setActiveAccount };
}
