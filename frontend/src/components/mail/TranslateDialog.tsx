"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import {
  translateText,
  detectLanguage,
  stripHtmlForDetection,
  fetchLanguages,
  type LibreLanguage,
} from "./MessageContextMenu";

let cachedLanguages: LibreLanguage[] | null = null;

export interface TranslationResult {
  translatedHtml: string;
  sourceLang: string;
  sourceLabel: string;
  targetLabel: string;
}

interface TranslateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  htmlBody: string;
  textBody: string;
  onTranslated: (result: TranslationResult) => void;
}

export function TranslateDialog({
  open,
  onOpenChange,
  htmlBody,
  textBody,
  onTranslated,
}: TranslateDialogProps) {
  const t = useT();
  const [languages, setLanguages] = useState<LibreLanguage[]>(cachedLanguages || []);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [targetLang, setTargetLang] = useState("fr");
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectText = useMemo(() => {
    let text = stripHtmlForDetection(textBody || "");
    if (text.length < 20) {
      text = stripHtmlForDetection(htmlBody || "");
    }
    return text;
  }, [textBody, htmlBody]);

  useEffect(() => {
    if (!open) return;
    if (cachedLanguages) {
      setLanguages(cachedLanguages);
      return;
    }
    fetchLanguages().then((langs) => {
      if (langs.length > 0) {
        cachedLanguages = langs;
        setLanguages(langs);
      }
    });
  }, [open]);

  useEffect(() => {
    if (!open || !detectText) return;
    setDetectedLang(null);
    setError(null);
    setDetecting(true);
    detectLanguage(detectText)
      .then((lang) => setDetectedLang(lang))
      .catch(() => setDetectedLang("auto"))
      .finally(() => setDetecting(false));
  }, [open, detectText]);

  const getLanguageName = useCallback(
    (code: string): string => {
      const lang = languages.find((l) => l.code === code);
      return lang?.name || code;
    },
    [languages],
  );

  const handleTranslate = useCallback(async () => {
    const content = htmlBody || textBody;
    if (!content) return;
    setTranslating(true);
    setError(null);
    try {
      const source = detectedLang && detectedLang !== "auto" ? detectedLang : "auto";
      const format = htmlBody ? "html" : "text";
      const result = await translateText(content, targetLang, source, format);
      onTranslated({
        translatedHtml: result,
        sourceLang: source,
        sourceLabel: source !== "auto" ? getLanguageName(source) : "Auto",
        targetLabel: getLanguageName(targetLang),
      });
      onOpenChange(false);
    } catch {
      setError(t("message.translateError"));
    } finally {
      setTranslating(false);
    }
  }, [htmlBody, textBody, targetLang, detectedLang, t, onTranslated, onOpenChange, getLanguageName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("message.translate")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Langue d'origine */}
          <div className="space-y-1.5">
            <label className="text-muted-foreground text-sm font-medium">
              {t("translate.detectedLanguage")}
            </label>
            <div className="flex items-center gap-2 text-sm">
              {detecting ? (
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              ) : (
                <span className="font-medium">
                  {detectedLang && detectedLang !== "auto"
                    ? getLanguageName(detectedLang)
                    : "—"}
                </span>
              )}
            </div>
          </div>

          {/* Langue cible */}
          <div className="space-y-1.5">
            <label className="text-muted-foreground text-sm font-medium">
              {t("translate.targetLanguage")}
            </label>
            <Select value={targetLang} onValueChange={setTargetLang}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Spinner pendant traduction */}
          {translating && (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
              <span className="text-muted-foreground">{t("message.translating")}</span>
            </div>
          )}

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleTranslate} disabled={translating || (!htmlBody && !textBody)}>
            {translating && <Loader2 className="mr-2 size-4 animate-spin" />}
            {t("message.translate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
