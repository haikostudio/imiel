// Backfill de categorisation : applique des labels IA aux mails inbox des
// 90 derniers jours qui n'en ont pas encore. Process sequentiel, gentil avec
// le budget OpenRouter (200ms entre items).

import {
  listAccountsForUser,
  countRecords,
  getUserOpenRouterKey,
  listInboxFolderIds,
  listUncategorizedMessages,
  listActiveUserIds,
  getUserPauseFlags,
  invalidateUserPauseFlagsCache,
} from "./pocketbase";
import { categorizeAndApply } from "./imap";

const BACKFILL_WINDOW_DAYS = 90;
const PER_PAGE = 100;
const DELAY_BETWEEN_ITEMS_MS = 200;

// Top-up auto : rattrape les mails inbox recents que la categorisation live
// a rates (worker redemarre, promesse fire-and-forget perdue, LLM EMPTY).
// Fenetre courte (2h) pour borner le cout LLM des mails que le LLM refuse
// systematiquement de categoriser.

interface BackfillState {
  running: boolean;
  paused: boolean;
  total: number;
  done: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const states = new Map<string, BackfillState>();

export function getCategoryBackfillStatus(userId: string): BackfillState {
  return (
    states.get(userId) || {
      running: false,
      paused: false,
      total: 0,
      done: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  );
}

export function pauseCategoryBackfill(userId: string): BackfillState {
  const s = states.get(userId);
  if (s && s.running) s.paused = true;
  return getCategoryBackfillStatus(userId);
}

function isoSince(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

export async function getCategoryBackfillStats(
  userId: string
): Promise<{ totalUncategorized: number; windowDays: number }> {
  const accounts = await listAccountsForUser(userId);
  const sinceIso = isoSince(BACKFILL_WINDOW_DAYS);
  let total = 0;
  for (const acc of accounts) {
    const inboxIds = await listInboxFolderIds(acc.id);
    for (const fid of inboxIds) {
      total += await countRecords(
        "messages",
        `folder="${fid}" && date >= "${sinceIso}" && is_draft=false && labels:length=0`
      );
    }
  }
  return { totalUncategorized: total, windowDays: BACKFILL_WINDOW_DAYS };
}

export function startCategoryBackfill(userId: string): BackfillState {
  const current = states.get(userId);
  if (current && current.running) return current;
  invalidateUserPauseFlagsCache(userId);

  const state: BackfillState = {
    running: true,
    paused: false,
    total: 0,
    done: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  states.set(userId, state);

  void (async () => {
    try {
      const apiKey =
        (await getUserOpenRouterKey(userId)) || process.env.OPENROUTER_API_KEY || "";
      if (!apiKey) {
        state.error = "OpenRouter API key manquante";
        return;
      }

      try {
        const stats = await getCategoryBackfillStats(userId);
        state.total = stats.totalUncategorized;
      } catch (err) {
        console.error("[category-backfill] stats failed:", err);
      }

      const accounts = await listAccountsForUser(userId);
      const sinceIso = isoSince(BACKFILL_WINDOW_DAYS);

      for (const acc of accounts) {
        const inboxIds = await listInboxFolderIds(acc.id);
        for (const fid of inboxIds) {
          // On reste sur page=1 : chaque message categorise sort du filtre
          // labels:length=0, la requete suivante avance naturellement.
          while (true) {
            let res;
            try {
              res = await listUncategorizedMessages(fid, sinceIso, 1, PER_PAGE);
            } catch (err) {
              console.error("[category-backfill] page failed:", err);
              state.error = (err as Error).message || "page fetch failed";
              break;
            }
            if (res.items.length === 0) break;

            for (const item of res.items) {
              if (!state.running) return;
              const flags = await getUserPauseFlags(userId);
              if (state.paused || flags.ai_categorize_paused) {
                state.paused = true;
                return;
              }
              try {
                await categorizeAndApply(item.id, userId, {
                  subject: item.subject || "",
                  from: item.from_address || { address: "" },
                  bodyText: item.text_body || item.snippet || "",
                  threadId: item.thread_id,
                });
              } catch (err) {
                console.warn("[category-backfill] item failed:", err);
              }
              state.done++;
              await new Promise((r) => setTimeout(r, DELAY_BETWEEN_ITEMS_MS));
            }
          }
        }
      }
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[category-backfill] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return state;
}
