/**
 * Coquille native iPhone (application iMiel, Capacitor) : la page web
 * tourne dans l'application et parle au code natif par le greffon maison
 * "HaikoBridge" (mobile/ios/App/App/HaikoBridgePlugin.swift).
 *
 * - Cle d'appareil : emise par le worker avec la SESSION, puis rangee dans le
 *   trousseau partage app <-> widgets (jamais en stockage web). Les widgets et
 *   les actions de notification (Accepter / Refuser) signent leurs requetes avec.
 * - Notifications : APNs gere par le natif (AppDelegate) ; la fenetre d'Apple
 *   ne s'ouvre qu'apres le geste "Activer" de l'application.
 * Aucune dependance npm : on passe par window.Capacitor, injecte par la coquille.
 */
import pb, { getCurrentUserId } from "@/lib/pocketbase";

interface HaikoBridgePlugin {
  saveDeviceKey(o: { deviceId: string; secret: string; baseUrl: string }): Promise<void>;
  clearDeviceKey(): Promise<void>;
  hasDeviceKey(): Promise<{ present: boolean; deviceId?: string }>;
  enableNotifications(): Promise<{ granted: boolean }>;
  notificationStatus(): Promise<{ status: "granted" | "denied" | "notDetermined" | "provisional" }>;
  reloadWidgets(): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
  registerPlugin?: (name: string) => unknown;
}

function cap(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor) || null;
}

/** Vrai dans l'application iPhone (pas dans Safari ni la PWA). */
export function isNativeApp(): boolean {
  const c = cap();
  return !!c?.isNativePlatform?.() && c.getPlatform?.() === "ios";
}

let bridgeInstance: HaikoBridgePlugin | null = null;
export function haikoBridge(): HaikoBridgePlugin | null {
  if (!isNativeApp()) return null;
  if (bridgeInstance) return bridgeInstance;
  const c = cap();
  const p = (c?.Plugins?.HaikoBridge as HaikoBridgePlugin | undefined) || (c?.registerPlugin?.("HaikoBridge") as HaikoBridgePlugin | undefined);
  bridgeInstance = p || null;
  return bridgeInstance;
}

let ensuring: Promise<boolean> | null = null;

/**
 * Garantit une cle d'appareil dans le trousseau (une seule a la fois : deux
 * appels rapproches creeraient deux cles). Rend vrai si une cle est en place.
 */
export function ensureDeviceKey(): Promise<boolean> {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const bridge = haikoBridge();
    const userId = getCurrentUserId();
    if (!bridge || !userId || !pb.authStore.token) return false;
    try {
      const has = await bridge.hasDeviceKey().catch(() => ({ present: false, deviceId: "" }));
      if (has.present && has.deviceId?.startsWith(`${userId}.`)) return true;
      const res = await fetch("/worker/device/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
        body: JSON.stringify({ platform: "ios", deviceName: "iPhone" }),
      });
      if (!res.ok) return false;
      const key = (await res.json()) as { deviceId: string; secret: string };
      await bridge.saveDeviceKey({ ...key, baseUrl: window.location.origin });
      return true;
    } catch {
      return false;
    } finally {
      ensuring = null;
    }
  })();
  return ensuring;
}

/** Deconnexion : la cle est revoquee cote serveur PUIS effacee du trousseau. */
export async function revokeNativeDevice(): Promise<void> {
  const bridge = haikoBridge();
  if (!bridge) return;
  await bridge.clearDeviceKey().catch(() => {});
}

export async function nativeNotificationsGranted(): Promise<boolean> {
  const bridge = haikoBridge();
  if (!bridge) return false;
  const s = await bridge.notificationStatus().catch(() => ({ status: "denied" as const }));
  return s.status === "granted" || s.status === "provisional";
}

/** Apres le geste "Activer" : cle d'appareil puis autorisation d'Apple + jeton APNs. */
export async function enableNativeNotifications(): Promise<boolean> {
  const bridge = haikoBridge();
  if (!bridge) return false;
  await ensureDeviceKey();
  const r = await bridge.enableNotifications().catch(() => ({ granted: false }));
  return r.granted;
}
