"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plug, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import pb from "@/lib/pocketbase";

interface AccountTestButtonProps {
  imapHost: string;
  imapPort: number;
  imapSecurity: "none" | "ssl" | "starttls";
  imapEmail: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "none" | "ssl" | "starttls";
  smtpEmail: string;
  smtpPassword: string;
}

interface TestResult {
  imap: { ok: boolean; message: string };
  smtp: { ok: boolean; message: string };
}

async function testConnection(
  type: "imap" | "smtp",
  host: string,
  port: number,
  email: string,
  password: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
      body: JSON.stringify({ type, host, port, email, password }),
    });
    const data = await res.json();
    if (data.success) {
      return { ok: true, message: "Connexion reussie" };
    }
    return { ok: false, message: data.error || "Echec de la connexion" };
  } catch {
    return { ok: false, message: "Impossible de contacter le mail-worker" };
  }
}

export default function AccountTestButton({
  imapHost,
  imapPort,
  imapSecurity,
  imapEmail,
  imapPassword,
  smtpHost,
  smtpPort,
  smtpSecurity,
  smtpEmail,
  smtpPassword,
}: AccountTestButtonProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function handleTest() {
    setTesting(true);
    setResult(null);

    try {
      const [imap, smtp] = await Promise.all([
        imapHost
          ? testConnection("imap", imapHost, imapPort, imapEmail, imapPassword)
          : { ok: false, message: "Hote IMAP non configure" },
        smtpHost
          ? testConnection("smtp", smtpHost, smtpPort, smtpEmail, smtpPassword)
          : { ok: false, message: "Hote SMTP non configure" },
      ]);
      setResult({ imap, smtp });
    } catch {
      setResult({
        imap: { ok: false, message: "Impossible de contacter le serveur" },
        smtp: { ok: false, message: "Impossible de contacter le serveur" },
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div data-ref="settings-account-test" className="space-y-3">
      <Button
        type="button"
        variant="outline"
        onClick={handleTest}
        data-ref="settings-account-test-btn"
        disabled={testing || (!imapHost && !smtpHost)}
      >
        {testing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Plug className="size-4" />
        )}
        Tester la connexion
      </Button>

      {result && (
        <div data-ref="settings-account-test-result" className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            {result.imap.ok ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <XCircle className="size-4 text-destructive" />
            )}
            <span className={cn(result.imap.ok ? "text-success" : "text-destructive")}>
              IMAP : {result.imap.message}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {result.smtp.ok ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <XCircle className="size-4 text-destructive" />
            )}
            <span className={cn(result.smtp.ok ? "text-success" : "text-destructive")}>
              SMTP : {result.smtp.message}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
