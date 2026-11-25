"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { pushTokens, getCurrentUserId } from "@/lib/pocketbase";
import { isDesktopApp } from "@/lib/desktop";
import { enableNativeNotifications, isNativeApp, nativeNotificationsGranted } from "@/lib/native-app";
import {
  ensureNativeNotifyPermission,
  nativeNotifyGranted,
} from "@/lib/desktop-notify";

type PermissionState = "default" | "granted" | "denied" | "unsupported";

interface UseNotificationsReturn {
  permission: PermissionState;
  subscribe: () => Promise<string>;
  unsubscribe: () => Promise<void>;
  isIOS: boolean;
  isStandalone: boolean;
  needsInstall: boolean;
  isDesktop: boolean;
  currentEndpoint: string | null;
  hasActiveSubscription: boolean;
  refreshSubscription: () => Promise<void>;
}

function getInitialPermission(): PermissionState {
  if (typeof window === "undefined") return "default";
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return "unsupported";
  }
  return Notification.permission as PermissionState;
}

function isIOSSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function checkStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    ("standalone" in window.navigator &&
      (window.navigator as unknown as { standalone?: boolean }).standalone ===
        true) ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

async function getExistingEndpoint(): Promise<string | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

export function useNotifications(): UseNotificationsReturn {
  const [permission, setPermission] =
    useState<PermissionState>(getInitialPermission);
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [nativeGranted, setNativeGranted] = useState(false);

  const isIOS = useMemo(() => isIOSSafari(), []);
  const isStandalone = useMemo(() => checkStandalone(), []);
  const isDesktop = useMemo(() => isDesktopApp(), []);
  // Application iPhone (coquille native) : notifications APNs par le natif.
  const isNativeIos = useMemo(() => isNativeApp(), []);
  // Sur l'app de bureau (WKWebView), le Web Push est indisponible : on ne passe
  // jamais par l'install PWA iOS.
  const needsInstall = isIOS && !isStandalone && !isDesktop && !isNativeIos;

  const refreshSubscription = useCallback(async () => {
    if (isNativeIos) {
      const ok = await nativeNotificationsGranted();
      setNativeGranted(ok);
      if (ok) setPermission("granted");
      return;
    }
    if (isDesktop) {
      setNativeGranted(await nativeNotifyGranted());
      return;
    }
    const ep = await getExistingEndpoint();
    setCurrentEndpoint(ep);
  }, [isDesktop, isNativeIos]);

  useEffect(() => {
    refreshSubscription();
  }, [refreshSubscription]);

  const subscribe = useCallback(async (): Promise<string> => {
    const userId = getCurrentUserId();
    if (!userId) {
      throw new Error("Utilisateur non connecte");
    }

    // Application iPhone : cle d'appareil + autorisation d'Apple + jeton APNs,
    // enregistre par le natif (requete signee).
    if (isNativeIos) {
      const ok = await enableNativeNotifications();
      setPermission(ok ? "granted" : "denied");
      setNativeGranted(ok);
      if (!ok) throw new Error("Permission de notification refusee (Reglages > iMiel > Notifications)");
      return "ios-native";
    }

    // App de bureau : notifications natives via le plugin Tauri (le Web Push
    // ne marche pas dans la WKWebView). On demande la permission OS et c'est
    // le WebSocket temps reel qui declenchera les notifications.
    if (isDesktop) {
      const ok = await ensureNativeNotifyPermission();
      setPermission(ok ? "granted" : "denied");
      setNativeGranted(ok);
      if (!ok) throw new Error("Permission de notification refusee");
      return "desktop-native";
    }

    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setPermission("unsupported");
      throw new Error("Notifications non supportees par ce navigateur");
    }

    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) {
      throw new Error(
        "Cle VAPID publique manquante (NEXT_PUBLIC_VAPID_PUBLIC_KEY)"
      );
    }

    const result = await Notification.requestPermission();
    setPermission(result as PermissionState);

    if (result !== "granted") {
      throw new Error("Permission de notification refusee");
    }

    // Sur localhost, le layout desenregistre le SW au demarrage :
    // `serviceWorker.ready` bloque alors indefiniment. On detecte l'absence
    // d'enregistrement (getRegistration resout immediatement avec undefined)
    // pour fail fast au lieu de laisser le bouton suspendu en busy. Sur le
    // VPS/prod le SW est enregistre, on tente meme registration explicite si
    // besoin (premier chargement avant le 'load' event).
    let existingReg = await navigator.serviceWorker.getRegistration();
    if (!existingReg) {
      try {
        existingReg = await navigator.serviceWorker.register("/sw.js");
      } catch {
        // ignore, gere ci-dessous
      }
    }
    if (!existingReg) {
      throw new Error(
        "Service worker non enregistre (notifications indisponibles en dev)"
      );
    }
    const registration = await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
    }

    const sub = subscription.toJSON();
    const endpoint = sub.endpoint ?? "";
    const p256dh = (sub.keys as Record<string, string>)?.p256dh ?? "";
    const authKey = (sub.keys as Record<string, string>)?.auth ?? "";

    if (!endpoint || !p256dh || !authKey) {
      throw new Error("Souscription push incomplete");
    }

    try {
      const existing = await pushTokens().getFirstListItem(
        `user = "${userId}" && endpoint = "${endpoint.replace(/"/g, '\\"')}"`
      );
      await pushTokens().update(existing.id, {
        p256dh,
        auth_key: authKey,
        device_name: navigator.userAgent.slice(0, 100),
        is_active: true,
      });
    } catch {
      await pushTokens().create({
        user: userId,
        endpoint,
        p256dh,
        auth_key: authKey,
        device_name: navigator.userAgent.slice(0, 100),
        is_active: true,
      });
    }

    setCurrentEndpoint(endpoint);
    return endpoint;
  }, [isDesktop, isNativeIos]);

  const unsubscribe = useCallback(async () => {
    const userId = getCurrentUserId();
    if (!userId) return;

    // App de bureau : pas d'abonnement push a nettoyer (notifs natives). La
    // permission OS, elle, se gere depuis les reglages systeme.
    if (isDesktop || isNativeIos) {
      setNativeGranted(false);
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    let endpoint: string | null = null;
    if (subscription) {
      endpoint = subscription.endpoint;
      try {
        await subscription.unsubscribe();
      } catch {
        // Browser unsub a echoue, on poursuit pour nettoyer la BDD
      }
    }

    if (endpoint) {
      try {
        const existing = await pushTokens().getFirstListItem(
          `user = "${userId}" && endpoint = "${endpoint.replace(/"/g, '\\"')}"`
        );
        await pushTokens().delete(existing.id);
      } catch {
        // Token deja absent en BDD
      }
    }

    setCurrentEndpoint(null);
  }, [isDesktop, isNativeIos]);

  return {
    permission,
    subscribe,
    unsubscribe,
    isIOS,
    isStandalone,
    needsInstall,
    isDesktop,
    currentEndpoint,
    hasActiveSubscription: isDesktop || isNativeIos
      ? nativeGranted
      : currentEndpoint !== null,
    refreshSubscription,
  };
}
