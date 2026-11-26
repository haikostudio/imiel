"use client";

// iMiel Cloud : ajouter une boite SANS aucun reglage. Gmail et Outlook se
// relient d'un clic (connexion du fournisseur) ; les autres boites avec
// l'adresse et le mot de passe : le serveur trouve les reglages et essaie la
// connexion avant d'enregistrer. iCloud et Yahoo imposent un mot de passe
// d'application : l'ecran le dit et donne le lien du fournisseur.
import { useEffect, useRef, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { cloud, ErreurCloud } from "@/lib/cloud/client";
import { synchroniser } from "@/lib/cloud/sync";
import { openExternalUrl } from "@/lib/desktop";

type Detection = { fournisseur: string; nom: string; methode: string; guide?: string; devine?: boolean };

function LogoGoogle() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function LogoMicrosoft() {
  return (
    <svg viewBox="0 0 23 23" className="size-5" aria-hidden>
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}

export function CloudAddBox({ onAjoutee }: { onAjoutee?: () => void }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [occupe, setOccupe] = useState<"" | "google" | "microsoft" | "ajout">("");
  const [erreur, setErreur] = useState("");
  const [attenteOauth, setAttenteOauth] = useState(false);
  const minuteur = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reglages trouves des que l'adresse est complete (sans rien demander).
  useEffect(() => {
    setDetection(null);
    if (minuteur.current) clearTimeout(minuteur.current);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.trim())) return;
    minuteur.current = setTimeout(() => {
      void cloud<Detection>("GET", `/v1/detection?email=${encodeURIComponent(email.trim())}`)
        .then(setDetection)
        .catch(() => {});
    }, 500);
  }, [email]);

  async function oauth(f: "google" | "microsoft") {
    setErreur("");
    setOccupe(f);
    try {
      const r = await cloud<{ url: string }>("POST", `/v1/boites/oauth/${f}`, { indice: email.trim() || undefined });
      openExternalUrl(r.url);
      setAttenteOauth(true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe("");
    }
  }

  async function ajouter(ev: React.FormEvent) {
    ev.preventDefault();
    setErreur("");
    if (detection?.methode === "oauth-google") return void oauth("google");
    if (detection?.methode === "oauth-microsoft") return void oauth("microsoft");
    setOccupe("ajout");
    try {
      await cloud("POST", "/v1/boites", { email: email.trim(), motDePasse });
      setMotDePasse("");
      void synchroniser();
      onAjoutee?.();
    } catch (e) {
      const d = e instanceof ErreurCloud ? e.donnees : {};
      if (d.methode === "oauth-google") return void oauth("google");
      if (d.methode === "oauth-microsoft") return void oauth("microsoft");
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe("");
    }
  }

  const appli = detection?.methode === "mot-de-passe-application";
  const parConnexion = detection?.methode === "oauth-google" || detection?.methode === "oauth-microsoft";

  return (
    <div data-ref="cloud-add-box" className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" className="h-11 justify-center gap-2" disabled={!!occupe} onClick={() => oauth("google")} data-ref="cloud-add-google">
          {occupe === "google" ? <Loader2 className="size-4 animate-spin" /> : <LogoGoogle />}
          {t("cloud.addBox.google")}
        </Button>
        <Button type="button" variant="outline" className="h-11 justify-center gap-2" disabled={!!occupe} onClick={() => oauth("microsoft")} data-ref="cloud-add-microsoft">
          {occupe === "microsoft" ? <Loader2 className="size-4 animate-spin" /> : <LogoMicrosoft />}
          {t("cloud.addBox.microsoft")}
        </Button>
      </div>
      {attenteOauth && (
        <div data-ref="cloud-add-oauth-wait" className="bg-muted/60 rounded-lg p-3 text-sm">
          {t("cloud.addBox.oauthWait")}{" "}
          <button type="button" className="underline" onClick={() => { void synchroniser(); onAjoutee?.(); }}>
            {t("cloud.addBox.oauthDone")}
          </button>
        </div>
      )}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        {t("cloud.addBox.other")}
        <span className="bg-border h-px flex-1" />
      </div>
      <form onSubmit={ajouter} className="flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cloud-box-email">{t("cloud.addBox.email")}</Label>
          <Input id="cloud-box-email" data-ref="cloud-add-email" type="email" autoComplete="email" inputMode="email" placeholder="vous@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {detection && (
            <p data-ref="cloud-add-detection" className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Mail className="size-3.5" />
              {parConnexion
                ? t("cloud.addBox.detectedOauth", { nom: detection.nom })
                : detection.methode === "non-pris-en-charge"
                  ? t("cloud.addBox.unsupported", { nom: detection.nom })
                  : detection.devine
                    ? t("cloud.addBox.guessed")
                    : t("cloud.addBox.detected", { nom: detection.nom })}
            </p>
          )}
        </div>
        {!parConnexion && (
          <div className="grid gap-1.5">
            <Label htmlFor="cloud-box-password">{appli ? t("cloud.addBox.appPassword") : t("cloud.addBox.password")}</Label>
            <Input id="cloud-box-password" data-ref="cloud-add-password" type="password" autoComplete="current-password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} required />
            {appli && detection?.guide && (
              <p className="text-muted-foreground text-xs" data-ref="cloud-add-app-password-guide">
                {t("cloud.addBox.appPasswordHelp", { nom: detection.nom })}{" "}
                <button type="button" className="underline" onClick={() => openExternalUrl(detection.guide!)}>
                  {t("cloud.addBox.appPasswordLink")}
                </button>
              </p>
            )}
          </div>
        )}
        {erreur && (
          <p data-ref="cloud-add-error" role="alert" className="text-destructive text-sm">
            {erreur}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={!!occupe || detection?.methode === "non-pris-en-charge"} data-ref="cloud-add-submit">
          {occupe === "ajout" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> {t("cloud.addBox.checking")}
            </>
          ) : parConnexion ? (
            t("cloud.addBox.connectWith", { nom: detection!.nom })
          ) : (
            t("cloud.addBox.submit")
          )}
        </Button>
      </form>
    </div>
  );
}
