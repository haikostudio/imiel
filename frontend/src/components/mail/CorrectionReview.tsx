"use client";

import { useCallback, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// --- Strip HTML to plain text ---

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

// --- Word-level diff (LCS) ---

interface DiffOp {
  type: "equal" | "delete" | "insert";
  value: string;
}

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function computeWordDiff(original: string, corrected: string): DiffOp[] {
  const a = tokenize(original);
  const b = tokenize(corrected);
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: "equal", value: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "insert", value: b[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "delete", value: a[i - 1] });
      i--;
    }
  }

  return ops;
}

// --- Group diff ops into segments + corrections ---

interface CorrectionItem {
  id: number;
  original: string;
  corrected: string;
}

interface Segment {
  type: "unchanged" | "correction";
  text?: string;
  correctionId?: number;
}

function groupDiff(ops: DiffOp[]): {
  segments: Segment[];
  corrections: CorrectionItem[];
} {
  const segments: Segment[] = [];
  const corrections: CorrectionItem[] = [];
  let nextId = 0;
  let i = 0;

  while (i < ops.length) {
    if (ops[i].type === "equal") {
      let text = "";
      while (i < ops.length && ops[i].type === "equal") {
        text += ops[i].value;
        i++;
      }
      segments.push({ type: "unchanged", text });
    } else {
      let original = "";
      let corrected = "";
      while (i < ops.length && ops[i].type !== "equal") {
        if (ops[i].type === "delete") original += ops[i].value;
        else corrected += ops[i].value;
        i++;
      }

      // Skip whitespace-only changes
      if (original.trim() === corrected.trim()) {
        segments.push({ type: "unchanged", text: corrected || original });
        continue;
      }

      const id = nextId++;
      corrections.push({ id, original, corrected });
      segments.push({ type: "correction", correctionId: id });
    }
  }

  return { segments, corrections };
}

// --- Component ---

interface CorrectionReviewProps {
  originalHtml: string;
  correctedHtml: string;
  originalSubject?: string;
  correctedSubject?: string;
  onApply: (html: string, subject?: string) => void;
  onDismiss: () => void;
}

export function CorrectionReview({
  originalHtml,
  correctedHtml,
  originalSubject,
  correctedSubject,
  onApply,
  onDismiss,
}: CorrectionReviewProps) {
  const t = useT();

  const { segments, corrections, subjectChanged } = useMemo(() => {
    const origText = stripHtml(originalHtml);
    const corrText = stripHtml(correctedHtml);
    const ops = computeWordDiff(origText, corrText);
    const grouped = groupDiff(ops);
    const subjectChanged =
      !!correctedSubject &&
      !!originalSubject &&
      correctedSubject !== originalSubject;
    return { ...grouped, subjectChanged };
  }, [originalHtml, correctedHtml, originalSubject, correctedSubject]);

  const [accepted, setAccepted] = useState<Set<number>>(
    () => new Set(corrections.map((c) => c.id))
  );
  const [subjectAccepted, setSubjectAccepted] = useState(true);

  const totalCorrections = corrections.length + (subjectChanged ? 1 : 0);

  const toggleCorrection = useCallback((id: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const acceptAll = useCallback(() => {
    setAccepted(new Set(corrections.map((c) => c.id)));
    setSubjectAccepted(true);
  }, [corrections]);

  const acceptedCount =
    accepted.size + (subjectAccepted && subjectChanged ? 1 : 0);

  const handleApply = useCallback(() => {
    let finalHtml: string;
    if (accepted.size === corrections.length) {
      finalHtml = correctedHtml;
    } else if (accepted.size === 0) {
      finalHtml = originalHtml;
    } else {
      // Start from corrected HTML, revert rejected corrections
      finalHtml = correctedHtml;
      for (const c of corrections) {
        if (!accepted.has(c.id) && c.corrected.trim() && c.original.trim()) {
          finalHtml = finalHtml.replace(c.corrected.trim(), c.original.trim());
        }
      }
    }

    const finalSubject =
      subjectAccepted && subjectChanged ? correctedSubject : originalSubject;
    onApply(finalHtml, finalSubject);
  }, [
    accepted,
    corrections,
    correctedHtml,
    originalHtml,
    subjectAccepted,
    subjectChanged,
    correctedSubject,
    originalSubject,
    onApply,
  ]);

  if (totalCorrections === 0) return null;

  return (
    <div className="border-input bg-muted/30 flex flex-col gap-3 rounded-md border p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {acceptedCount}/{totalCorrections} {t("compose.corrections")}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" onClick={acceptAll}>
            {t("compose.acceptAll")}
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onDismiss}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Subject correction */}
      {subjectChanged && (
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors",
            subjectAccepted ? "bg-green-500/10" : "bg-muted"
          )}
          onClick={() => setSubjectAccepted(!subjectAccepted)}
        >
          <span className="text-muted-foreground shrink-0 text-xs">
            {t("compose.subject")}:
          </span>
          {subjectAccepted ? (
            <>
              <span className="text-red-500/70 line-through">
                {originalSubject}
              </span>
              <span className="font-medium text-green-600 dark:text-green-400">
                {correctedSubject}
              </span>
              <Check className="ml-auto size-3 shrink-0 text-green-600" />
            </>
          ) : (
            <span>{originalSubject}</span>
          )}
        </button>
      )}

      {/* Body diff */}
      {corrections.length > 0 && (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {segments.map((seg, idx) => {
            if (seg.type === "unchanged") {
              return <span key={idx}>{seg.text}</span>;
            }

            const c = corrections.find((x) => x.id === seg.correctionId);
            if (!c) return null;

            const isAccepted = accepted.has(c.id);

            return (
              <span
                key={idx}
                role="button"
                tabIndex={0}
                className={cn(
                  "inline cursor-pointer rounded-sm px-0.5 transition-colors",
                  isAccepted
                    ? "bg-green-500/15 hover:bg-green-500/25"
                    : "bg-muted hover:bg-muted/80"
                )}
                onClick={() => toggleCorrection(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    toggleCorrection(c.id);
                }}
              >
                {isAccepted ? (
                  <>
                    {c.original && (
                      <span className="text-red-500/60 line-through">
                        {c.original}
                      </span>
                    )}
                    {c.original && c.corrected && " "}
                    {c.corrected && (
                      <span className="font-medium text-green-700 dark:text-green-400">
                        {c.corrected}
                      </span>
                    )}
                  </>
                ) : (
                  <span>{c.original || c.corrected}</span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Apply button */}
      <div className="flex justify-end">
        <Button size="sm" onClick={handleApply} disabled={acceptedCount === 0}>
          <Check className="size-4" />
          {t("compose.apply")} ({acceptedCount})
        </Button>
      </div>
    </div>
  );
}
