"use client";

import { useState } from "react";
import { useAccounts } from "@/lib/hooks/useAccounts";
import { getCurrentUserId } from "@/lib/pocketbase";
import { getOAuthRedirectOrigin } from "@/lib/oauth-origin";
import { EDITION_POUR_TOUS } from "@/lib/ai-settings";
import type { Account } from "@/lib/pocketbase";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ACCOUNT_COLORS, getNextAvailableColor } from "@/lib/utils/account-colors";
import { Loader2, Mail, PenLine } from "lucide-react";
import { hashNavigate } from "@/lib/hash-router";
import { isSignatureEmpty } from "@/lib/signature";
import AccountTestButton from "./AccountTestButton";

interface AccountFormProps {
  account?: Account;
  usedColors?: string[];
  onSuccess?: () => void;
  formId?: string;
}

interface FormData {
  label: string;
  email: string;
  display_name: string;
  color: string;
  protocol: "imap" | "pop3";
  imap_host: string;
  imap_port: string;
  imap_username: string;
  imap_password: string;
  imap_security: "none" | "ssl" | "starttls";
  smtp_host: string;
  smtp_port: string;
  smtp_username: string;
  smtp_password: string;
  smtp_security: "none" | "ssl" | "starttls";
  check_interval: string;
  signature: string;
  is_active: boolean;
}

const CHECK_INTERVALS = [
  { value: "1", label: "1 minute" },
  { value: "2", label: "2 minutes" },
  { value: "3", label: "3 minutes" },
  { value: "5", label: "5 minutes" },
  { value: "10", label: "10 minutes" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "60 minutes" },
];

function getDefaultFormData(account?: Account, usedColors?: string[]): FormData {
  return {
    label: account?.label ?? "",
    email: account?.email ?? "",
    display_name: account?.display_name ?? "",
    color: account?.color || getNextAvailableColor(usedColors ?? []),
    protocol: account?.protocol ?? "imap",
    imap_host: account?.imap_host ?? "",
    imap_port: String(account?.imap_port ?? 993),
    imap_username: account?.imap_username ?? "",
    imap_password: account?.imap_password ?? "",
    imap_security: account?.imap_security ?? "ssl",
    smtp_host: account?.smtp_host ?? "",
    smtp_port: String(account?.smtp_port ?? 587),
    smtp_username: account?.smtp_username ?? "",
    smtp_password: account?.smtp_password ?? "",
    smtp_security: account?.smtp_security ?? "starttls",
    check_interval: String(account?.check_interval ?? 5),
    signature: account?.signature ?? "",
    is_active: account?.is_active ?? true,
  };
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

export default function AccountForm({ account, usedColors = [], onSuccess, formId }: AccountFormProps) {
  const t = useT();
  const { createAccount, updateAccount } = useAccounts();
  const [form, setForm] = useState<FormData>(() => getDefaultFormData(account, usedColors));
  const [saving, setSaving] = useState(false);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  const [providerChoice, setProviderChoice] = useState<"manual" | "gmail" | null>(null);

  const isEdit = !!account;
  const isOAuth2 = account?.auth_type === "oauth2";
  const showForm = isEdit || providerChoice !== null;

  // Version pour tous : Gmail par MOT DE PASSE D'APPLICATION, guide pas a pas.
  // La connexion Google au courrier (portee https://mail.google.com/, restreinte,
  // audit de securite annuel) n'existe que sur l'instance de l'editeur.
  function choisirGmail() {
    setProviderChoice("gmail");
    setForm((prev) => ({
      ...prev,
      label: prev.label || "Gmail",
      imap_host: "imap.gmail.com",
      imap_port: "993",
      imap_security: "ssl",
      smtp_host: "smtp.gmail.com",
      smtp_port: "587",
      smtp_security: "starttls",
    }));
  }

  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function validate(): boolean {
    const newErrors: Partial<Record<keyof FormData, string>> = {};

    if (!form.label.trim()) newErrors.label = t("account.labelRequired");
    if (!form.email.trim()) newErrors.email = t("account.emailRequired");
    if (form.protocol === "imap") {
      if (!form.imap_host.trim()) newErrors.imap_host = t("account.imapRequired");
      if (!form.smtp_host.trim()) newErrors.smtp_host = t("account.smtpRequired");
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleGoogleOAuth() {
    const userId = getCurrentUserId();
    if (!userId) {
      toast.error("Non authentifie");
      return;
    }

    setConnectingGoogle(true);
    try {
      const res = await fetch(`/worker/oauth/google/url?userId=${userId}&origin=${encodeURIComponent(getOAuthRedirectOrigin())}`);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error(data.error || t("account.oauthError"));
      }
    } catch {
      toast.error(t("account.oauthError"));
    } finally {
      setConnectingGoogle(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const data = {
        label: form.label,
        email: form.email,
        display_name: form.display_name,
        color: form.color,
        protocol: form.protocol,
        imap_host: form.imap_host || undefined,
        imap_port: form.imap_port ? Number(form.imap_port) : undefined,
        imap_security: form.imap_security,
        imap_username: form.imap_username || undefined,
        imap_password: form.imap_password || undefined,
        smtp_host: form.smtp_host || undefined,
        smtp_port: form.smtp_port ? Number(form.smtp_port) : undefined,
        smtp_security: form.smtp_security,
        smtp_username: form.smtp_username || undefined,
        smtp_password: form.smtp_password || undefined,
        check_interval: Number(form.check_interval),
        is_active: form.is_active,
      };

      if (isEdit) {
        await updateAccount(account.id, data);
        toast.success(t("account.updated"));
      } else {
        await createAccount(data);
        toast.success(t("account.created"));
      }

      onSuccess?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("account.saveError")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    {/* Service provider selector - only for new accounts */}
    {!isEdit && !providerChoice && (
      <div className="space-y-3" data-ref="settings-account-provider-select">
        <Label>{t("account.chooseService")}</Label>
        <div className="grid gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            disabled={connectingGoogle}
            onClick={EDITION_POUR_TOUS ? choisirGmail : handleGoogleOAuth}
            data-ref="settings-account-provider-google"
          >
            {connectingGoogle ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <GoogleIcon className="size-4" />
            )}
            Google
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            onClick={() => setProviderChoice("manual")}
          >
            <Mail className="size-4" />
            {t("account.otherProvider")}
          </Button>
        </div>
      </div>
    )}

    {showForm && (
    <form id={formId} onSubmit={handleSubmit} className="space-y-8" data-ref="settings-account-form">
      {providerChoice === "gmail" && (
        <div data-ref="gmail-app-password-guide" className="space-y-2 rounded-xl bg-muted p-4 text-sm">
          <p className="font-semibold">{t("gmail.title")}</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              {t("gmail.step1")}{" "}
              <a className="underline underline-offset-2" href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">
                {t("gmail.open")}
              </a>
            </li>
            <li>
              {t("gmail.step2")}{" "}
              <a className="underline underline-offset-2" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                {t("gmail.open")}
              </a>
            </li>
            <li>{t("gmail.step3")}</li>
          </ol>
          <p className="text-muted-foreground">{t("gmail.note")}</p>
        </div>
      )}
      {/* OAuth2 badge for existing OAuth accounts */}
      {isOAuth2 && (
        <div className="flex items-center justify-between">
          <Badge variant="secondary">
            <GoogleIcon className="size-3 mr-1.5" />
            {t("account.oauthConnected")}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleGoogleOAuth}
            disabled={connectingGoogle}
          >
            {connectingGoogle && <Loader2 className="size-3 animate-spin mr-1" />}
            {t("account.oauthReconnect")}
          </Button>
        </div>
      )}

      {/* Informations generales */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="label">{t("account.label")}</Label>
          <Input
            id="label"
            data-ref="settings-account-form-label"
            placeholder="Mon email professionnel"
            value={form.label}
            onChange={(e) => updateField("label", e.target.value)}
            readOnly={isOAuth2}
          />
          {errors.label && (
            <p className="text-sm text-destructive">{errors.label}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">{t("account.email")}</Label>
          <Input
            id="email"
            type="email"
            data-ref="settings-account-form-email"
            placeholder="contact@example.com"
            value={form.email}
            onChange={(e) => updateField("email", e.target.value)}
            readOnly={isOAuth2}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="display_name">{t("account.displayName")}</Label>
          <Input
            id="display_name"
            data-ref="settings-account-form-name"
            placeholder="Jean Dupont"
            value={form.display_name}
            onChange={(e) => updateField("display_name", e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>{t("account.color")}</Label>
          <div className="flex flex-wrap gap-2">
            {ACCOUNT_COLORS.map((c) => {
              const isTaken = usedColors.includes(c.value) && form.color !== c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  disabled={isTaken}
                  title={isTaken ? t("account.colorTaken") : c.label}
                  onClick={() => updateField("color", c.value)}
                  className={cn(
                    "size-8 rounded-full border-2 transition-all",
                    form.color === c.value
                      ? "border-foreground scale-110"
                      : "border-transparent",
                    isTaken && "opacity-25 cursor-not-allowed"
                  )}
                  style={{ backgroundColor: c.value }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Hide IMAP/SMTP config for OAuth2 accounts */}
      {!isOAuth2 && (
        <>
          <Separator />

          {/* Reception (IMAP ou POP3) */}
          <div className="space-y-4">
            <h3 data-ref="settings-account-form-imap" className="text-lg font-medium">{t("account.receive")}</h3>

            <div className="space-y-2">
              <Label>{t("account.protocol")}</Label>
              <RadioGroup
                data-ref="settings-account-form-protocol"
                value={form.protocol}
                onValueChange={(v) => updateField("protocol", v as "imap" | "pop3")}
                className="flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="imap" id="proto-imap" />
                  <Label htmlFor="proto-imap" className="font-normal">
                    {t("account.imap")}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="pop3" id="proto-pop3" />
                  <Label htmlFor="proto-pop3" className="font-normal">
                    {t("account.pop3")}
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="imap_host">{t("account.server")}</Label>
                <Input
                  id="imap_host"
                  data-ref="settings-account-form-imap-host"
                  placeholder="imap.example.com"
                  value={form.imap_host}
                  onChange={(e) => updateField("imap_host", e.target.value)}
                />
                {errors.imap_host && (
                  <p className="text-sm text-destructive">{errors.imap_host}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="imap_port">{t("account.port")}</Label>
                <Input
                  id="imap_port"
                  type="number"
                  value={form.imap_port}
                  onChange={(e) => updateField("imap_port", e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="imap_username">{t("account.username")}</Label>
                <Input
                  id="imap_username"
                  value={form.imap_username}
                  onChange={(e) => updateField("imap_username", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="imap_password">{t("account.password")}</Label>
                <Input
                  id="imap_password"
                  type="password"
                  value={form.imap_password}
                  onChange={(e) => updateField("imap_password", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="imap_security">{t("account.security")}</Label>
              <Select
                value={form.imap_security}
                onValueChange={(v) => updateField("imap_security", v as FormData["imap_security"])}
              >
                <SelectTrigger id="imap_security" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("account.securityNone")}</SelectItem>
                  <SelectItem value="ssl">{t("account.securitySsl")}</SelectItem>
                  <SelectItem value="starttls">{t("account.securityStarttls")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          {/* Envoi (SMTP) */}
          <div className="space-y-4">
            <h3 data-ref="settings-account-form-smtp" className="text-lg font-medium">{t("account.send")}</h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="smtp_host">{t("account.server")}</Label>
                <Input
                  id="smtp_host"
                  data-ref="settings-account-form-smtp-host"
                  placeholder="smtp.example.com"
                  value={form.smtp_host}
                  onChange={(e) => updateField("smtp_host", e.target.value)}
                />
                {errors.smtp_host && (
                  <p className="text-sm text-destructive">{errors.smtp_host}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp_port">{t("account.port")}</Label>
                <Input
                  id="smtp_port"
                  type="number"
                  value={form.smtp_port}
                  onChange={(e) => updateField("smtp_port", e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="smtp_username">{t("account.username")}</Label>
                <Input
                  id="smtp_username"
                  value={form.smtp_username}
                  onChange={(e) => updateField("smtp_username", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp_password">{t("account.password")}</Label>
                <Input
                  id="smtp_password"
                  type="password"
                  value={form.smtp_password}
                  onChange={(e) => updateField("smtp_password", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="smtp_security">{t("account.security")}</Label>
              <Select
                value={form.smtp_security}
                onValueChange={(v) => updateField("smtp_security", v as FormData["smtp_security"])}
              >
                <SelectTrigger id="smtp_security" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("account.securityNone")}</SelectItem>
                  <SelectItem value="ssl">{t("account.securitySsl")}</SelectItem>
                  <SelectItem value="starttls">{t("account.securityStarttls")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </>
      )}

      <Separator />

      {/* Options */}
      <div className="space-y-4">
        <h3 data-ref="settings-account-form-options" className="text-lg font-medium">{t("account.options")}</h3>

        <div className="space-y-2">
          <Label htmlFor="check_interval">{t("account.checkInterval")}</Label>
          <Select
            value={form.check_interval}
            onValueChange={(v) => updateField("check_interval", v)}
          >
            <SelectTrigger id="check_interval" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECK_INTERVALS.map((interval) => (
                <SelectItem key={interval.value} value={interval.value}>
                  {interval.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Signature : editee dans l'onglet dedie (editeur riche, images) ;
            le formulaire du compte ne l'ecrit plus, pour ne jamais ecraser
            une signature enregistree entre-temps. */}
        {isEdit && (
          <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
            <div className="min-w-0">
              <Label>{t("account.signature")}</Label>
              <p className="text-muted-foreground text-xs">
                {isSignatureEmpty(account?.signature) ? t("signature.none") : t("signature.defined")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-ref="settings-account-form-signature"
              onClick={() => hashNavigate(`/settings?tab=signatures&account=${account!.id}`)}
            >
              <PenLine className="size-4" />
              {t("signature.edit")}
            </Button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Switch
            id="is_active"
            data-ref="settings-account-form-active"
            checked={form.is_active}
            onCheckedChange={(v) => updateField("is_active", v)}
          />
          <Label htmlFor="is_active" className="font-normal">
            {t("account.active")}
          </Label>
        </div>
      </div>

      {/* Test connexion - only for password accounts */}
      {!isOAuth2 && (
        <>
          <Separator />
          <AccountTestButton
            imapHost={form.imap_host}
            imapPort={Number(form.imap_port)}
            imapSecurity={form.imap_security}
            imapEmail={form.imap_username}
            imapPassword={form.imap_password}
            smtpHost={form.smtp_host}
            smtpPort={Number(form.smtp_port)}
            smtpSecurity={form.smtp_security}
            smtpEmail={form.smtp_username}
            smtpPassword={form.smtp_password}
          />
        </>
      )}
    </form>
    )}
    </>
  );
}
