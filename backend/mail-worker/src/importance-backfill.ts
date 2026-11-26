/**
 * Rattrapage UNIQUE du niveau d'importance des mails recus les 30 derniers
 * jours (tri en trois niveaux, migration 075).
 *
 * - Un SEUL passage, au premier demarrage du worker apres la mise a jour :
 *   drapeau persistant sur le volume du cache vecteurs (comme ai-budget.ts).
 *   Ce n'est PAS un cron : une fois `done`, plus jamais relance.
 * - Borne : 30 jours, 2000 mails par utilisateur, lots espaces (300 ms).
 * - Sous le plafond journalier (aiFetch source "importance-backfill") : si le
 *   budget du jour est atteint, le passage s'arrete, pose le repli heuristique
 *   sur le mail en cours et reprend APRES minuit (Paris), une seule fois.
 * - Les mails deja classes par l'IA, une regle ou une correction ne sont pas
 *   repasses ; seuls les vides et les replis heuristiques le sont.
 * - Les labels existants ne sont pas touches (seulement remplis si absents).
 */
import fs from "fs";
import path from "path";
import { categorizeMessageFull } from "./categorizer";
import { decideImportance, type Importance } from "./importance";
import { isBudgetExceeded, nextParisMidnight, serverOpenRouterKey } from "./ai-budget";
import {
  getImportanceContext,
  getUserOpenRouterKey,
  getUserPauseFlags,
  listActiveUserIds,
  listAccountsForUser,
  listInboxFolderIds,
  listInboxMessagesForImportance,
  updateMessage,
} from "./pocketbase";
import { getSenderTrustCountsFromSqlite } from "./sqlite-direct";
import { legacyRenamed } from "./renamed-file";

const WINDOW_DAYS = 30;
const MAX_PER_USER = 2000;
const DELAY_MS = 300;

const STATE_PATH =
  process.env.IMPORTANCE_BACKFILL_STATE_PATH ||
  legacyRenamed(
    path.join(path.dirname(process.env.EMBEDDINGS_CACHE_PATH || "/tmp/imiel-vectors.db"), "imiel-importance-backfill.json")
  );

interface PassState {
  done: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  aiClassified: number;
  heuristic: number;
  stoppedForBudget: boolean;
}

let running = false;

function readState(): PassState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as PassState;
  } catch {
    return {
      done: false,
      startedAt: null,
      finishedAt: null,
      processed: 0,
      aiClassified: 0,
      heuristic: 0,
      stoppedForBudget: false,
    };
  }
}

function writeState(s: PassState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s));
  } catch (err) {
    console.warn("[importance-backfill] etat non ecrit:", (err as Error).message);
  }
}

export function getImportanceBackfillState(): PassState & { running: boolean } {
  return { ...readState(), running };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lance le passage s'il n'a jamais abouti. Sans effet sinon. */
export async function runImportanceBackfillOnce(): Promise<void> {
  if (running) return;
  const state = readState();
  if (state.done) return;
  running = true;
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.stoppedForBudget = false;
  // Fenetre ancree sur le PREMIER depart : une reprise apres minuit ne
  // l'etend pas.
  const since = new Date(new Date(state.startedAt).getTime() - WINDOW_DAYS * 86400_000)
    .toISOString()
    .replace("T", " ");
  console.log(`[importance-backfill] depart (mails depuis ${since})`);
  try {
    const users = await listActiveUserIds();
    outer: for (const userId of users) {
      const flags = await getUserPauseFlags(userId).catch(() => null);
      const apiKey = (await getUserOpenRouterKey(userId).catch(() => "")) || serverOpenRouterKey() || "";
      const accounts = await listAccountsForUser(userId);
      let count = 0;
      for (const account of accounts) {
        const folders = await listInboxFolderIds(account.id);
        for (const folderId of folders) {
          for (let page = 1; page < 100; page++) {
            const res = await listInboxMessagesForImportance(folderId, since, page, 100);
            for (const m of res.items) {
              if (count >= MAX_PER_USER) break;
              const src = m.importance_source || "";
              if (m.importance && (src === "ai" || src === "rule" || src === "user")) continue;
              count++;
              const fromAddress = m.from_address?.address || "";
              const trust = fromAddress ? getSenderTrustCountsFromSqlite(userId, fromAddress) : null;
              const fromSelf = fromAddress.toLowerCase() === (account.email || "").toLowerCase();
              const ctx = await getImportanceContext(userId);
              let ai: Importance | null = null;
              const aiAllowed = !!apiKey && !flags?.ai_categorize_paused && !isBudgetExceeded();
              if (aiAllowed) {
                const r = await categorizeMessageFull(
                  {
                    subject: m.subject || "",
                    from: { name: m.from_address?.name, address: fromAddress },
                    bodyText: m.text_body || m.snippet || "",
                    existingLabels: [],
                    signals: {
                      sentToCount: trust?.sentToCount ?? 0,
                      receivedInboxCount: trust?.receivedInboxCount ?? 0,
                    },
                    examples: ctx.examples,
                  },
                  { apiKey, source: "importance-backfill" }
                );
                ai = r?.importance ?? null;
              }
              const decided = decideImportance({
                rules: ctx.rules,
                fromAddress,
                subject: m.subject,
                sentToCount: trust?.sentToCount ?? 0,
                fromSelf,
                ai,
              });
              if (decided.importance !== m.importance || decided.source !== src) {
                await updateMessage(m.id, {
                  importance: decided.importance,
                  importance_source: decided.source,
                }).catch(() => {});
              }
              state.processed++;
              if (decided.source === "ai") state.aiClassified++;
              else state.heuristic++;
              if (state.processed % 50 === 0) writeState(state);
              if (aiAllowed && !ai && isBudgetExceeded()) {
                state.stoppedForBudget = true;
                break outer;
              }
              await sleep(DELAY_MS);
            }
            if (count >= MAX_PER_USER || page >= res.totalPages) break;
          }
        }
      }
    }
    if (state.stoppedForBudget) {
      const at = nextParisMidnight();
      console.warn(
        `[importance-backfill] plafond IA du jour atteint apres ${state.processed} mails : reprise a ${at.toISOString()}`
      );
      writeState(state);
      setTimeout(() => void runImportanceBackfillOnce(), at.getTime() - Date.now() + 5 * 60_000);
    } else {
      state.done = true;
      state.finishedAt = new Date().toISOString();
      writeState(state);
      console.log(
        `[importance-backfill] termine : ${state.processed} mails (IA ${state.aiClassified}, repli ${state.heuristic})`
      );
    }
  } catch (err) {
    writeState(state);
    console.warn("[importance-backfill] erreur:", (err as Error).message);
  } finally {
    running = false;
  }
}
