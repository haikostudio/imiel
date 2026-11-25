interface DiffOp {
  type: "equal" | "delete" | "insert";
  value: string;
}

export interface CorrectionItem {
  id: number;
  original: string;
  corrected: string;
}

export interface DiffSegment {
  type: "unchanged" | "correction";
  text?: string;
  correctionId?: number;
}

export function stripHtml(html: string): string {
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

function groupDiff(ops: DiffOp[]): {
  segments: DiffSegment[];
  corrections: CorrectionItem[];
} {
  const segments: DiffSegment[] = [];
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

export function computeDiff(originalHtml: string, correctedHtml: string): {
  segments: DiffSegment[];
  corrections: CorrectionItem[];
} {
  const origText = stripHtml(originalHtml);
  const corrText = stripHtml(correctedHtml);
  const ops = computeWordDiff(origText, corrText);
  return groupDiff(ops);
}
