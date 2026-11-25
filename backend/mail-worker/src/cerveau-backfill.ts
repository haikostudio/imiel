// Agregation Cerveau de l'historique, en DEUX phases distinctes :
//   1) ANALYSE (dry-run) : scanne tout l'historique, applique le filtre
//      "vrai echange", et MEMORISE la liste des mails eligibles. N'envoie RIEN.
//   2) ENVOI : pousse EXACTEMENT les mails reperes par l'analyse (+ notes de
//      thread). Ne se lance qu'apres une analyse terminee.
// Sequentiel, gentil avec l'API Cerveau, idempotent (upsert par discussion_id).

import {
  listAccountsForUser,
  countRecords,
  countRealFolderMessages,
  getUserCerveauKey,
  getUserPauseFlags,
  invalidateUserPauseFlagsCache,
  listMessagesForCerveau,
  listMessagesForCerveauByIds,
  listThreadBriefs,
} from "./pocketbase";
import {
  pushMemory,
  pushThreadBrief,
  renderMessageMemory,
  messageDiscussionId,
  toCerveauInput,
  shouldAggregateMail,
} from "./cerveau";
import { hasAnySecondaryLabel } from "./labels";

const PER_PAGE = 100;
const SEND_CHUNK = 50;
const DELAY_BETWEEN_ITEMS_MS = 150;
// Fenetre d'agregation : on ne pousse que les mails des 3 derniers mois.
const WINDOW_DAYS = 90;

function isoSince(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

type Phase = "idle" | "analyzing" | "analyzed" | "sending" | "done";

interface BackfillState {
  phase: Phase;
  running: boolean;
  paused: boolean;
  total: number; // mails candidats (dossiers reels)
  done: number; // elements traites sur la passe en cours
  eligible: number; // vrais echanges reperes (mails + notes) par l'analyse
  pushed: number; // elements reellement envoyes (phase envoi)
  error: string | null;
  analyzedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

function emptyState(): BackfillState {
  return {
    phase: "idle",
    running: false,
    paused: false,
    total: 0,
    done: 0,
    eligible: 0,
    pushed: 0,
    error: null,
    analyzedAt: null,
    startedAt: null,
    finishedAt: null,
  };
}

const states = new Map<string, BackfillState>();
// Liste des ids de mails eligibles reperes par la derniere analyse (hors state
// HTTP pour ne pas renvoyer un gros tableau dans /cerveau/status).
const eligibleIds = new Map<string, string[]>();

export function getCerveauBackfillStatus(userId: string): BackfillState {
  return states.get(userId) || emptyState();
}

export function pauseCerveauBackfill(userId: string): BackfillState {
  const s = states.get(userId);
  if (s && s.running) s.paused = true;
  return getCerveauBackfillStatus(userId);
}

export async function getCerveauBackfillStats(
  userId: string
): Promise<{ totalMessages: number; totalBriefs: number; total: number }> {
  const accounts = await listAccountsForUser(userId);
  const sinceIso = isoSince(WINDOW_DAYS);
  let totalMessages = 0;
  for (const acc of accounts) {
    totalMessages += await countRealFolderMessages(acc.id, sinceIso);
  }
  const totalBriefs = await countRecords("thread_briefs", `user="${userId}"`);
  return { totalMessages, totalBriefs, total: totalMessages + totalBriefs };
}

// --- Phase 1 : ANALYSE (dry-run, n'envoie rien) ----------------------------

export function startCerveauAnalysis(userId: string): BackfillState {
  const current = states.get(userId);
  if (current && current.running) return current;
  invalidateUserPauseFlagsCache(userId);

  const state = emptyState();
  state.phase = "analyzing";
  state.running = true;
  state.startedAt = Date.now();
  states.set(userId, state);
  const found: string[] = [];
  eligibleIds.set(userId, found);

  void (async () => {
    try {
      const apiKey = await getUserCerveauKey(userId);
      if (!apiKey) {
        state.error = "cle Cerveau manquante";
        return;
      }
      try {
        state.total = (await getCerveauBackfillStats(userId)).total;
      } catch (err) {
        console.error("[cerveau-analyze] stats failed:", err);
      }

      const accounts = await listAccountsForUser(userId);
      const sinceIso = isoSince(WINDOW_DAYS);
      let briefCount = 0;

      for (const acc of accounts) {
        let page = 1;
        while (true) {
          if (!state.running) return;
          if (state.paused) return;
          let res;
          try {
            res = await listMessagesForCerveau(acc.id, page, PER_PAGE, sinceIso);
          } catch (err) {
            console.error("[cerveau-analyze] page failed:", err);
            state.error = (err as Error).message || "page fetch failed";
            break;
          }
          if (res.items.length === 0) break;
          for (const item of res.items) {
            if (!state.running || state.paused) return;
            try {
              const isSecondary = item.labels?.length
                ? await hasAnySecondaryLabel(userId, item.labels)
                : false;
              const ok = await shouldAggregateMail(acc, {
                isSent: item.is_sent,
                senderEmail: item.from_address?.address,
                isSecondary,
              });
              if (ok) {
                found.push(item.id);
                state.eligible++;
              }
            } catch (err) {
              console.warn("[cerveau-analyze] item failed:", err);
            }
            state.done++;
          }
          if (page >= res.totalPages) break;
          page++;
        }
      }

      // Les notes de thread sont toutes eligibles (syntheses de conversations).
      try {
        briefCount = await countRecords("thread_briefs", `user="${userId}"`);
      } catch {
        // ignore
      }
      state.eligible += briefCount;
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[cerveau-analyze] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      // Analyse validee seulement si terminee sans interruption ni erreur.
      if (!state.paused && !state.error) {
        state.phase = "analyzed";
        state.analyzedAt = Date.now();
      } else {
        state.phase = "idle";
        eligibleIds.delete(userId);
      }
    }
  })();

  return state;
}

// --- Phase 2 : ENVOI (pousse les mails reperes par l'analyse) ---------------

export function startCerveauSend(userId: string): BackfillState {
  const current = states.get(userId);
  if (current && current.running) return current;
  const ids = eligibleIds.get(userId);
  if (!ids) {
    // Pas d'analyse prealable : on refuse (l'UI ne devrait pas l'autoriser).
    const s = emptyState();
    s.error = "analyse requise avant l'envoi";
    states.set(userId, s);
    return s;
  }
  invalidateUserPauseFlagsCache(userId);

  const state = emptyState();
  state.phase = "sending";
  state.running = true;
  state.startedAt = Date.now();
  state.eligible = ids.length; // notes ajoutees plus bas
  states.set(userId, state);

  void (async () => {
    try {
      const apiKey = await getUserCerveauKey(userId);
      if (!apiKey) {
        state.error = "cle Cerveau manquante";
        return;
      }

      // 1) Mails eligibles, par lots (recharge -> rendu -> push).
      for (let i = 0; i < ids.length; i += SEND_CHUNK) {
        if (!state.running || state.paused) return;
        const flags = await getUserPauseFlags(userId);
        if (flags.cerveau_paused) {
          state.paused = true;
          return;
        }
        const chunk = ids.slice(i, i + SEND_CHUNK);
        let items;
        try {
          items = await listMessagesForCerveauByIds(chunk);
        } catch (err) {
          console.error("[cerveau-send] chunk fetch failed:", err);
          continue;
        }
        for (const item of items) {
          if (!state.running || state.paused) return;
          try {
            const texte = await renderMessageMemory(toCerveauInput(item), userId);
            await pushMemory(apiKey, {
              texte,
              source: "haikomail",
              discussion_id: messageDiscussionId(item.id),
            });
            state.pushed++;
          } catch (err) {
            console.warn("[cerveau-send] item failed:", err);
          }
          state.done++;
          await new Promise((r) => setTimeout(r, DELAY_BETWEEN_ITEMS_MS));
        }
      }

      // 2) Notes de thread (toutes).
      let bpage = 1;
      while (true) {
        if (!state.running || state.paused) return;
        let res;
        try {
          res = await listThreadBriefs(userId, bpage, PER_PAGE);
        } catch (err) {
          console.error("[cerveau-send] briefs page failed:", err);
          break;
        }
        if (res.items.length === 0) break;
        state.eligible = ids.length + res.totalItems;
        for (const brief of res.items) {
          if (!state.running || state.paused) return;
          try {
            await pushThreadBrief(apiKey, brief.thread_id, brief.content);
            state.pushed++;
          } catch (err) {
            console.warn("[cerveau-send] brief failed:", err);
          }
          state.done++;
          await new Promise((r) => setTimeout(r, DELAY_BETWEEN_ITEMS_MS));
        }
        if (bpage >= res.totalPages) break;
        bpage++;
      }
    } catch (err) {
      state.error = (err as Error).message || String(err);
      console.error("[cerveau-send] fatal:", err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      // Interrompu -> on garde "analyzed" pour pouvoir relancer l'envoi.
      state.phase = state.paused ? "analyzed" : "done";
    }
  })();

  return state;
}
