// Abonnement iMiel Cloud : paiement, portail, et passage de l'ordinateur en
// version gratuite quand l'abonnement s'arrete.
import pb from "@/lib/pocketbase";
import { openExternalUrl } from "@/lib/desktop";
import { cloud, useCloud } from "./client";
import { ecrireSession, estIphoneLocal, estOrdinateurCloud } from "./config";

/** iPhone : aucun achat ni lien d'achat dans l'app (regle 3.1.3(f) d'Apple). */
export const paiementPermis = () => !estIphoneLocal();

export async function ouvrirPaiement(): Promise<void> {
  if (!paiementPermis()) return;
  const r = await cloud<{ url: string }>("POST", "/v1/abonnement/payer", {});
  openExternalUrl(r.url);
}

export async function ouvrirPortail(): Promise<void> {
  if (!paiementPermis()) return;
  const r = await cloud<{ url: string }>("POST", "/v1/abonnement/portail", {});
  openExternalUrl(r.url);
}

export async function seDeconnecter(): Promise<void> {
  await cloud("POST", "/v1/deconnexion", {}).catch(() => {});
  ecrireSession(null);
  useCloud.getState().set({ relie: false, ecran: true, abonnement: null });
}

type Tauri = { __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } } };

/**
 * Ordinateur : continuer GRATUITEMENT avec la version libre. Les boites
 * reprennent leurs identifiants (donnes par le serveur a cet ordinateur) et
 * l'app relance sa pile locale en mode « Sur cet ordinateur » : elle releve
 * elle-meme, avec les reglages deja la. Gmail et Outlook relies d'un clic se
 * reconnectent par mot de passe d'application.
 */
export async function passerEnGratuit(): Promise<{ aReconnecter: string[] }> {
  if (!estOrdinateurCloud()) throw new Error("Seul l'ordinateur peut continuer en version gratuite.");
  const { reglages } = await cloud<{ reglages: { boites: Record<string, unknown>[] } }>("GET", "/v1/reglages?identifiants=1");
  const r = await pb.send("/api/cloud/gratuit", { method: "POST", body: { boites: reglages.boites } });
  ecrireSession(null);
  useCloud.getState().set({ relie: false, ecran: true, abonnement: null });
  const invoke = (window as unknown as Tauri).__TAURI__?.core?.invoke;
  if (invoke) await invoke("passer_gratuit");
  return { aReconnecter: r.a_reconnecter || [] };
}
