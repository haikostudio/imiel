// Notifications natives pour l'app de bureau Tauri.
//
// Le Web Push (VAPID + pushManager) ne fonctionne PAS dans la WKWebView de
// Tauri (macOS) : Notification.requestPermission() y renvoie toujours "denied".
// A la place, on declenche des notifications OS natives via le plugin Tauri
// `notification`, alimentees par le WebSocket temps reel (nouveaux mails).
//
// On appelle l'IPC Tauri en direct (window.__TAURI_INTERNALS__.invoke) pour
// eviter d'ajouter les paquets npm @tauri-apps/* au build web. Les commandes
// du plugin sont stables : `is_permission_granted`, `request_permission`,
// `notify`. Hors app de bureau, toutes ces fonctions sont des no-op surs.

import { isDesktopApp } from "@/lib/desktop";

type TauriInvoke = (
  cmd: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

function getInvoke(): TauriInvoke | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  };
  const inv = w.__TAURI_INTERNALS__?.invoke;
  return typeof inv === "function" ? inv : null;
}

// Vrai si on peut esperer envoyer des notifications natives (app de bureau + IPC).
export function canNativeNotify(): boolean {
  return isDesktopApp() && getInvoke() !== null;
}

// Etat de permission SANS declencher de demande systeme (pour l'affichage).
export async function nativeNotifyGranted(): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    return (await invoke("plugin:notification|is_permission_granted")) === true;
  } catch {
    return false;
  }
}

let permissionReady: Promise<boolean> | null = null;

// Demande la permission systeme si besoin (memoise : une seule invite par session).
export function ensureNativeNotifyPermission(): Promise<boolean> {
  if (permissionReady) return permissionReady;
  const invoke = getInvoke();
  if (!invoke) return Promise.resolve(false);
  permissionReady = (async () => {
    try {
      if ((await invoke("plugin:notification|is_permission_granted")) === true) {
        return true;
      }
      const res = await invoke("plugin:notification|request_permission");
      return res === "granted";
    } catch {
      return false;
    }
  })();
  return permissionReady;
}

// Envoie une notification native (no-op si pas en app de bureau ou permission refusee).
export async function sendNativeNotification(
  title: string,
  body?: string
): Promise<boolean> {
  const invoke = getInvoke();
  if (!invoke) return false;
  if (!(await ensureNativeNotifyPermission())) return false;
  try {
    await invoke("plugin:notification|notify", {
      options: body ? { title, body } : { title },
    });
    return true;
  } catch {
    return false;
  }
}
