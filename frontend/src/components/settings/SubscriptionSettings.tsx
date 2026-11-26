"use client";

// Reglages > Abonnement (iMiel Cloud) : etat de l'abonnement, jours d'essai,
// appareils relies, derniere synchro, gerer le paiement, supprimer le compte.
// iPhone : aucun achat ni lien d'achat (regle 3.1.3(f) d'Apple).
import { useCallback, useEffect, useState } from "react";
import { CreditCard, Laptop, Loader2, LogOut, RefreshCw, Smartphone, Globe, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { cloud, useCloud, type Abonnement, type AppareilCloud } from "@/lib/cloud/client";
import { ecrireSession, estOrdinateurCloud } from "@/lib/cloud/config";
import { synchroniser } from "@/lib/cloud/sync";
import { ouvrirPaiement, ouvrirPortail, paiementPermis, passerEnGratuit, seDeconnecter } from "@/lib/cloud/abonnement";

const ICONES: Record<string, typeof Laptop> = { ordinateur: Laptop, iphone: Smartphone, web: Globe };
const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");

export default function SubscriptionSettings() {
  const t = useT();
  const { abonnement, email, synchro, derniereSynchro, erreur, set } = useCloud();
  const [appareils, setAppareils] = useState<AppareilCloud[]>([]);
  const [occupe, setOccupe] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [suppression, setSuppression] = useState(false);

  const charger = useCallback(async () => {
    const c = await cloud<{ email: string; abonnement: Abonnement; appareils: AppareilCloud[] }>("GET", "/v1/compte");
    set({ abonnement: c.abonnement, email: c.email });
    setAppareils(c.appareils);
  }, [set]);

  useEffect(() => {
    void charger().catch(() => {});
  }, [charger]);

  async function agir(nom: string, fn: () => Promise<unknown>) {
    setOccupe(nom);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe("");
    }
  }

  const a = abonnement;
  const etatTexte = !a
    ? "…"
    : a.etat === "essai"
      ? t("cloud.sub.trial", { jours: String(a.joursEssai ?? 0), date: date(a.essaiFin) })
      : a.etat === "actif"
        ? a.retard
          ? t("cloud.sub.late")
          : t("cloud.sub.active")
        : t("cloud.sub.stopped", { date: date(a.purgeLe) });

  return (
    <div data-ref="subscription-settings" className="flex flex-col gap-6">
      <section className="bg-card rounded-2xl border p-5" data-ref="subscription-state">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">iMiel Cloud</h2>
          <span className="text-muted-foreground text-sm">{a?.prix || "5,99 CHF / mois"}</span>
        </div>
        <p className="mt-1 text-sm" data-ref="subscription-state-text">{etatTexte}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t("cloud.sub.account", { email })}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {paiementPermis() && a && !a.paiementEnPlace && (
            <Button onClick={() => agir("payer", ouvrirPaiement)} disabled={!!occupe} data-ref="subscription-pay">
              {occupe === "payer" ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
              {a.etat === "arrete" ? t("cloud.sub.resume") : t("cloud.sub.addCard")}
            </Button>
          )}
          {paiementPermis() && a && (a.paiementEnPlace || a.retard) && (
            <Button variant="outline" onClick={() => agir("portail", ouvrirPortail)} disabled={!!occupe} data-ref="subscription-portal">
              {t("cloud.sub.manage")}
            </Button>
          )}
          {estOrdinateurCloud() && a?.etat === "arrete" && (
            <Button
              variant="outline"
              onClick={() =>
                agir("gratuit", async () => {
                  const r = await passerEnGratuit();
                  if (r.aReconnecter.length) toast.info(t("cloud.sub.reconnect", { boites: r.aReconnecter.join(", ") }));
                })
              }
              disabled={!!occupe}
              data-ref="subscription-free"
            >
              {occupe === "gratuit" && <Loader2 className="size-4 animate-spin" />}
              {t("cloud.sub.continueFree")}
            </Button>
          )}
        </div>
        {!paiementPermis() && a?.etat !== "actif" && <p className="text-muted-foreground mt-3 text-xs">{t("cloud.sub.iphoneNote")}</p>}
      </section>

      <section className="bg-card rounded-2xl border p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t("cloud.sub.sync")}</h2>
          <Button variant="ghost" size="sm" onClick={() => void synchroniser()} disabled={synchro === "en-cours"} data-ref="subscription-sync-now">
            <RefreshCw className={synchro === "en-cours" ? "size-4 animate-spin" : "size-4"} /> {t("cloud.sub.syncNow")}
          </Button>
        </div>
        <p className="text-muted-foreground mt-1 text-sm" data-ref="subscription-last-sync">
          {derniereSynchro ? t("cloud.sub.lastSync", { heure: new Date(derniereSynchro).toLocaleTimeString() }) : t("cloud.sub.neverSynced")}
        </p>
        {erreur && <p className="text-destructive mt-1 text-sm">{erreur}</p>}
        <p className="text-muted-foreground mt-3 text-xs">{t("cloud.sub.privacy")}</p>
      </section>

      <section className="bg-card rounded-2xl border p-5" data-ref="cloud-devices">
        <h2 className="text-base font-semibold">{t("cloud.sub.devices")}</h2>
        <ul className="mt-3 flex flex-col divide-y">
          {appareils.map((ap) => {
            const Icone = ICONES[ap.genre] || Laptop;
            return (
              <li key={ap.id} className="flex items-center gap-3 py-2.5">
                <Icone className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {ap.nom || ap.genre} {ap.moi && <span className="text-muted-foreground text-xs">({t("cloud.sub.thisDevice")})</span>}
                  </p>
                  <p className="text-muted-foreground text-xs">{t("cloud.sub.seen", { date: new Date(ap.vu).toLocaleString() })}</p>
                </div>
                {!ap.moi && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => agir(`retirer-${ap.id}`, async () => { await cloud("DELETE", `/v1/appareils/${ap.id}`); await charger(); })}
                    disabled={!!occupe}
                  >
                    {t("cloud.sub.remove")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border p-5">
        <Button variant="outline" className="w-fit" onClick={() => agir("deco", seDeconnecter)} disabled={!!occupe} data-ref="subscription-logout">
          <LogOut className="size-4" /> {t("cloud.sub.logout")}
        </Button>
        {!suppression ? (
          <button type="button" className="text-destructive w-fit text-sm underline" onClick={() => setSuppression(true)} data-ref="subscription-delete">
            {t("cloud.sub.delete")}
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{t("cloud.sub.deleteConfirm")}</p>
            <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder={email} />
            <Button
              variant="destructive"
              className="w-fit"
              disabled={!!occupe || confirmation.trim().toLowerCase() !== email}
              onClick={() =>
                agir("suppr", async () => {
                  await cloud("DELETE", "/v1/compte", { confirmation });
                  ecrireSession(null);
                  set({ relie: false, ecran: true, abonnement: null });
                })
              }
            >
              <Trash2 className="size-4" /> {t("cloud.sub.deleteForever")}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
