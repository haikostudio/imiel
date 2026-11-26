"use client";

// iMiel Cloud : premier ecran d'une app reliee au serveur de transfert
// (ordinateur en mode Cloud, iPhone, app web) tant qu'aucun compte n'est
// ouvert. Un compte = une adresse + un mot de passe ; 14 jours offerts, sans
// carte. Puis : « Ajoutez votre premiere boite ».
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { cloud, useCloud, type Abonnement } from "@/lib/cloud/client";
import { ecrireSession, genreAppareil } from "@/lib/cloud/config";
import { CloudAddBox } from "./CloudAddBox";
import { paiementPermis } from "@/lib/cloud/abonnement";

type Etape = "accueil" | "inscription" | "code" | "connexion" | "oubli" | "oubli-code" | "boite";

function nomAppareil(): string {
  if (typeof navigator === "undefined") return "Appareil";
  const ua = navigator.userAgent;
  const g = genreAppareil();
  if (g === "iphone") return "iPhone";
  const sys = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return g === "web" ? `Navigateur${sys ? ` (${sys})` : ""}` : `Ordinateur${sys ? ` ${sys}` : ""}`;
}

export function CloudGate({ onRelie }: { onRelie: () => void }) {
  const t = useT();
  // Deja relie (page rechargee pendant l'inscription) : on reprend a l'ajout de boite.
  const [etape, setEtape] = useState<Etape>(() => (useCloud.getState().relie ? "boite" : "accueil"));
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [mdp, setMdp] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState("");
  const [info, setInfo] = useState("");

  async function agir(fn: () => Promise<void>) {
    setErreur("");
    setOccupe(true);
    try {
      await fn();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }

  const ouvrirSession = (r: { jeton: string; appareilId: string; abonnement: Abonnement }) => {
    ecrireSession({ jeton: r.jeton, appareilId: r.appareilId, email: email.trim().toLowerCase() });
    useCloud.getState().set({ relie: true, email: email.trim().toLowerCase(), abonnement: r.abonnement });
  };
  const appareil = () => ({ nom: nomAppareil(), genre: genreAppareil() });

  const titre: Record<Etape, string> = {
    accueil: t("cloud.gate.title"),
    inscription: t("cloud.gate.signupTitle"),
    code: t("cloud.gate.codeTitle"),
    connexion: t("cloud.gate.loginTitle"),
    oubli: t("cloud.gate.forgotTitle"),
    "oubli-code": t("cloud.gate.forgotCodeTitle"),
    boite: t("cloud.gate.boxTitle"),
  };

  return (
    <div data-ref="cloud-gate" className="bg-background fixed inset-0 z-[200] overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-5 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" className="size-16 rounded-2xl shadow-sm" />
          <h1 className="text-xl font-semibold tracking-tight" data-ref="cloud-gate-title">{titre[etape]}</h1>
          {etape === "accueil" && <p className="text-muted-foreground text-sm">{t("cloud.gate.subtitle")}</p>}
          {etape === "code" && <p className="text-muted-foreground text-sm">{t("cloud.gate.codeSent", { email })}</p>}
          {etape === "boite" && <p className="text-muted-foreground text-sm">{t("cloud.gate.boxSubtitle")}</p>}
        </div>

        {etape === "accueil" && (
          <div className="flex flex-col gap-3">
            {/* iPhone : ni prix, ni essai gratuit, ni lien d'achat (App Store,
                regle 3.1.3(f) des apps compagnons gratuites) : seulement un compte. */}
            <Button className="h-12 text-base" onClick={() => setEtape("inscription")} data-ref="cloud-gate-signup">
              {paiementPermis() ? t("cloud.gate.startTrial") : t("cloud.gate.createAccount")}
            </Button>
            {paiementPermis() && <p className="text-muted-foreground text-center text-xs">{t("cloud.gate.noCard")}</p>}
            <Button variant="outline" className="h-11" onClick={() => setEtape("connexion")} data-ref="cloud-gate-login">
              {t("cloud.gate.haveAccount")}
            </Button>
          </div>
        )}

        {etape === "inscription" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void agir(async () => {
                const r = await cloud<{ code?: string }>("POST", "/v1/inscription", { email: email.trim() }, { sansSession: true });
                if (r.code) setInfo(r.code); // serveur en mode essai seulement
                setEtape("code");
              });
            }}
          >
            <Label htmlFor="cg-email">{t("cloud.gate.email")}</Label>
            <Input id="cg-email" data-ref="cloud-gate-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Button type="submit" className="h-11" disabled={occupe} data-ref="cloud-gate-send-code">
              {occupe && <Loader2 className="size-4 animate-spin" />} {t("cloud.gate.sendCode")}
            </Button>
          </form>
        )}

        {etape === "code" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void agir(async () => {
                const r = await cloud<{ jeton: string; appareilId: string; abonnement: Abonnement }>(
                  "POST",
                  "/v1/inscription/finir",
                  { email: email.trim(), code: code.trim(), motDePasse: mdp, appareil: appareil() },
                  { sansSession: true }
                );
                ouvrirSession(r);
                setEtape("boite");
              });
            }}
          >
            <Label htmlFor="cg-code">{t("cloud.gate.code")}</Label>
            <Input id="cg-code" data-ref="cloud-gate-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder={info || "123456"} required />
            <Label htmlFor="cg-mdp">{t("cloud.gate.newPassword")}</Label>
            <Input id="cg-mdp" data-ref="cloud-gate-password" type="password" autoComplete="new-password" minLength={8} value={mdp} onChange={(e) => setMdp(e.target.value)} required />
            <p className="text-muted-foreground text-xs">{t("cloud.gate.passwordHint")}</p>
            <Button type="submit" className="h-11" disabled={occupe} data-ref="cloud-gate-create">
              {occupe && <Loader2 className="size-4 animate-spin" />} {t("cloud.gate.create")}
            </Button>
          </form>
        )}

        {etape === "connexion" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void agir(async () => {
                const r = await cloud<{ jeton: string; appareilId: string; abonnement: Abonnement }>(
                  "POST",
                  "/v1/connexion",
                  { email: email.trim(), motDePasse: mdp, appareil: appareil() },
                  { sansSession: true }
                );
                ouvrirSession(r);
                onRelie();
              });
            }}
          >
            <Label htmlFor="cg-email2">{t("cloud.gate.email")}</Label>
            <Input id="cg-email2" data-ref="cloud-gate-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Label htmlFor="cg-mdp2">{t("cloud.gate.password")}</Label>
            <Input id="cg-mdp2" data-ref="cloud-gate-password" type="password" autoComplete="current-password" value={mdp} onChange={(e) => setMdp(e.target.value)} required />
            <Button type="submit" className="h-11" disabled={occupe} data-ref="cloud-gate-signin">
              {occupe && <Loader2 className="size-4 animate-spin" />} {t("cloud.gate.signin")}
            </Button>
            <button type="button" className="text-muted-foreground text-sm underline" onClick={() => setEtape("oubli")}>
              {t("cloud.gate.forgot")}
            </button>
          </form>
        )}

        {etape === "oubli" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void agir(async () => {
                const r = await cloud<{ code?: string }>("POST", "/v1/mot-de-passe/oubli", { email: email.trim() }, { sansSession: true });
                if (r.code) setInfo(r.code);
                setEtape("oubli-code");
              });
            }}
          >
            <Label htmlFor="cg-email3">{t("cloud.gate.email")}</Label>
            <Input id="cg-email3" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Button type="submit" className="h-11" disabled={occupe}>
              {t("cloud.gate.sendCode")}
            </Button>
          </form>
        )}

        {etape === "oubli-code" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void agir(async () => {
                await cloud("POST", "/v1/mot-de-passe/nouveau", { email: email.trim(), code: code.trim(), motDePasse: mdp }, { sansSession: true });
                setCode("");
                setEtape("connexion");
              });
            }}
          >
            <Label htmlFor="cg-code2">{t("cloud.gate.code")}</Label>
            <Input id="cg-code2" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder={info || "123456"} required />
            <Label htmlFor="cg-mdp3">{t("cloud.gate.newPassword")}</Label>
            <Input id="cg-mdp3" type="password" autoComplete="new-password" minLength={8} value={mdp} onChange={(e) => setMdp(e.target.value)} required />
            <Button type="submit" className="h-11" disabled={occupe}>
              {t("cloud.gate.savePassword")}
            </Button>
          </form>
        )}

        {etape === "boite" && (
          <div className="flex flex-col gap-4">
            <CloudAddBox onAjoutee={onRelie} />
            <button type="button" className="text-muted-foreground text-sm underline" onClick={onRelie} data-ref="cloud-gate-later">
              {t("cloud.gate.later")}
            </button>
          </div>
        )}

        {erreur && (
          <p role="alert" data-ref="cloud-gate-error" className="text-destructive text-center text-sm">
            {erreur}
          </p>
        )}
        {etape !== "accueil" && etape !== "boite" && (
          <button type="button" className="text-muted-foreground text-sm" onClick={() => { setErreur(""); setEtape("accueil"); }}>
            {t("cloud.gate.back")}
          </button>
        )}
      </div>
    </div>
  );
}
