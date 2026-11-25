"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Mail, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import pb, { accounts } from "@/lib/pocketbase";
import { useT } from "@/lib/i18n";

type Step = 1 | 2;

export default function SetupPage() {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Step 1 : Admin account
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState("");

  // Step 2 : Email account
  const [emailAddress, setEmailAddress] = useState("");
  const [emailName, setEmailName] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [emailPassword, setEmailPassword] = useState("");

  async function handleStep1(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (adminPassword !== adminPasswordConfirm) {
      setError(t("setup.passwordsMismatch"));
      return;
    }

    if (adminPassword.length < 8) {
      setError(t("setup.passwordMinLength"));
      return;
    }

    setLoading(true);
    try {
      await pb.collection("users").create({
        email: adminEmail,
        password: adminPassword,
        passwordConfirm: adminPasswordConfirm,
        name: "Administrateur",
      });
      await pb.collection("users").authWithPassword(adminEmail, adminPassword);
      setStep(2);
    } catch {
      setError(t("setup.createError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const userId = pb.authStore.record?.id;
      if (!userId) throw new Error(t("setup.notAuthenticated"));

      await accounts().create({
        user: userId,
        email: emailAddress,
        label: emailName || emailAddress.split("@")[0],
        display_name: emailName || "",
        protocol: "imap",
        imap_host: imapHost,
        imap_port: parseInt(imapPort, 10),
        imap_security: "ssl",
        imap_username: emailAddress,
        imap_password: emailPassword,
        smtp_host: smtpHost,
        smtp_port: parseInt(smtpPort, 10),
        smtp_security: "starttls",
        smtp_username: emailAddress,
        smtp_password: emailPassword,
        sync_status: "idle",
        is_active: true,
      });

      window.location.href = "/#/mail/inbox";
    } catch {
      setError(t("setup.addEmailError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          {step === 1 ? <Mail className="size-6" /> : <Server className="size-6" />}
        </div>
        <CardTitle className="text-xl">
          {step === 1 ? t("setup.initialSetup") : t("setup.addEmailAccount")}
        </CardTitle>
        <CardDescription>
          {step === 1
            ? t("setup.step1")
            : t("setup.step2")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {step === 1 ? (
          <form onSubmit={handleStep1} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-email">{t("login.email")}</Label>
              <Input
                id="admin-email"
                type="email"
                placeholder={t("setup.emailPlaceholder")}
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-password">{t("login.password")}</Label>
              <Input
                id="admin-password"
                type="password"
                placeholder={t("setup.passwordMinPlaceholder")}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-password-confirm">
                {t("setup.confirmPassword")}
              </Label>
              <Input
                id="admin-password-confirm"
                type="password"
                placeholder={t("setup.confirmPasswordPlaceholder")}
                value={adminPasswordConfirm}
                onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                required
                minLength={8}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? t("setup.creating") : t("setup.continue")}
              <ArrowRight className="size-4" />
            </Button>
          </form>
        ) : (
          <form onSubmit={handleStep2} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-name">{t("setup.displayName")}</Label>
              <Input
                id="email-name"
                type="text"
                placeholder={t("setup.displayNamePlaceholder")}
                value={emailName}
                onChange={(e) => setEmailName(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email-address">{t("login.email")}</Label>
              <Input
                id="email-address"
                type="email"
                placeholder={t("setup.emailPlaceholder")}
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email-password">{t("setup.emailPasswordLabel")}</Label>
              <Input
                id="email-password"
                type="password"
                placeholder={t("setup.emailPasswordPlaceholder")}
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="imap-host">{t("setup.imapServer")}</Label>
                <Input
                  id="imap-host"
                  type="text"
                  placeholder={t("setup.imapPlaceholder")}
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="imap-port">{t("account.port")}</Label>
                <Input
                  id="imap-port"
                  type="number"
                  className="w-20"
                  value={imapPort}
                  onChange={(e) => setImapPort(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="smtp-host">{t("setup.smtpServer")}</Label>
                <Input
                  id="smtp-host"
                  type="text"
                  placeholder={t("setup.smtpPlaceholder")}
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="smtp-port">{t("account.port")}</Label>
                <Input
                  id="smtp-port"
                  type="number"
                  className="w-20"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  required
                />
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? t("setup.adding") : t("setup.finish")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
