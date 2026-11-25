"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { Message } from "@/lib/pocketbase";

interface MessageSourceDialogProps {
  message: Message | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MessageSourceDialog({ message, open, onOpenChange }: MessageSourceDialogProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  if (!message) return null;

  const hasHeaders = !!message.raw_headers;
  const source = hasHeaders
    ? `${message.raw_headers}\r\n\r\n${message.html_body || message.text_body || ""}`
    : message.html_body || message.text_body || "";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{t("message.originalSource")}</DialogTitle>
            <Button variant="ghost" size="icon-sm" onClick={handleCopy}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        </DialogHeader>
        {!hasHeaders && (
          <p className="text-sm text-muted-foreground">
            {t("message.headersUnavailable")}
          </p>
        )}
        <pre className="overflow-auto rounded-md bg-muted p-4 text-xs font-mono whitespace-pre-wrap break-all max-h-[60vh]">
          {source}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
