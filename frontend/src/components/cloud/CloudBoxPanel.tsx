"use client";

// Reglages > Comptes en mode iMiel Cloud : ajouter une boite (sans reglage) ou
// gerer une boite reliee (nom, nom d'expediteur, mot de passe a refaire,
// retrait). Les identifiants ne vivent que sur le serveur, chiffres au repos.
import { useState } from "react";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { cloud } from "@/lib/cloud/client";
import { synchroniser } from "@/lib/cloud/sync";
import type { Account } from "@/lib/pocketbase";
import { CloudAddBox } from "./CloudAddBox";

export function CloudBoxPanel({ account, onRetour }: { account: Account | null; onRetour: () => void }) {
  const t = useT();
  const [label, setLabel] = useState(account?.label || "");
  const [nom, setNom] = useState(account?.display_name || "");
  const [mdp, setMdp] = useState("");
  const [occupe, setOccupe] = useState("");
  const aReconnecter = !!account?.sync_error;

  async function agir(n: string, fn: () => Promise<unknown>, ok?: string) {
    setOccupe(n);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe("");
    }
  }

  return (
    <div data-ref="cloud-box-panel" className="mx-auto flex max-w-xl flex-col gap-5 p-4 md:p-6">
      <button type="button" onClick={onRetour} className="text-muted-foreground flex w-fit items-center gap-1.5 text-sm">
        <ArrowLeft className="size-4" /> {t("cloud.box.back")}
      </button>
      {!account ? (
        <>
          <div>
            <h2 className="text-lg font-semibold">{t("cloud.box.addTitle")}</h2>
            <p className="text-muted-foreground text-sm">{t("cloud.box.addSubtitle")}</p>
          </div>
          <CloudAddBox onAjoutee={onRetour} />
        </>
      ) : (
        <>
          <div>
            <h2 className="text-lg font-semibold">{account.email}</h2>
            <p className="text-muted-foreground text-sm">{t("cloud.box.managed")}</p>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void agir("enreg", async () => {
                await cloud("PATCH", `/v1/boites/${account.id}`, { label, display_name: nom, ...(mdp ? { motDePasse: mdp } : {}) });
                setMdp("");
                await synchroniser();
              }, t("cloud.box.saved"));
            }}
          >
            <Label htmlFor="cb-label">{t("cloud.box.label")}</Label>
            <Input id="cb-label" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Label htmlFor="cb-nom">{t("cloud.box.senderName")}</Label>
            <Input id="cb-nom" value={nom} onChange={(e) => setNom(e.target.value)} />
            {account.auth_type !== "oauth2" && (
              <>
                <Label htmlFor="cb-mdp">{aReconnecter ? t("cloud.box.passwordNeeded") : t("cloud.box.newPassword")}</Label>
                <Input id="cb-mdp" type="password" autoComplete="new-password" value={mdp} onChange={(e) => setMdp(e.target.value)} />
              </>
            )}
            <Button type="submit" className="w-fit" disabled={!!occupe}>
              {occupe === "enreg" && <Loader2 className="size-4 animate-spin" />} {t("cloud.box.save")}
            </Button>
          </form>
          <Button
            variant="ghost"
            className="text-destructive w-fit"
            disabled={!!occupe}
            data-ref="cloud-box-remove"
            onClick={() =>
              agir("retirer", async () => {
                await cloud("DELETE", `/v1/boites/${account.id}`);
                await synchroniser();
                onRetour();
              })
            }
          >
            <Trash2 className="size-4" /> {t("cloud.box.remove")}
          </Button>
          <p className="text-muted-foreground text-xs">{t("cloud.box.removeNote")}</p>
        </>
      )}
    </div>
  );
}
