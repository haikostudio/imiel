import { authenticateDeviceRequest, issueDeviceKey, revokeDeviceKey } from "./device-keys";
import { widgetAgenda, widgetImportant, widgetTracking } from "./widgets-data";
import { upsertApnsToken } from "./pocketbase";
import { respondToInvitation, InvitationError } from "./invitations";
import { runImportanceBackfillOnce } from "./importance-backfill";
import dotenv from "dotenv";
import path from "path";

// Load .env from project root (../../.env relative to backend/mail-worker/)
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
// Also try local .env as fallback
dotenv.config();
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import { testImapConnection, fetchMessageSources } from "./imap";
import { buildSentSnippet, parseEmail } from "./parser";
import { sendEmail, testSmtpConnection } from "./smtp";
import {
  parseTrackingToken,
  recordSentReceipt,
  recordOpenReceipt,
  TRANSPARENT_GIF,
} from "./read-receipts";
import { sendPushToUser } from "./push";
import { logSentMailActivity } from "./activity";
import { getAllSyncStates } from "./scheduler";
import {
  startSyncEngine,
  syncWithLock,
  isSyncing,
  getEngineStatus,
} from "./sync-engine";
import { calculateThreadId } from "./threading";
import { type PBMessage, getAccount, createAccount, findAccountByEmail, createAttachment, getAttachment, deleteAttachment, getAttachmentsForMessage, createMessage, getMessage, findMessageByMessageId, updateAccount, updateMessage, updateMessageSafe, deleteMessage, findSpamFolder, listFolders, listMessages, listMessagesWithMissingAttachments } from "./pocketbase";
import { getUserCerveauKey, getThreadBrief, pruneActivitiesOlderThan, listTrackingContextForChat } from "./pocketbase";
import { generateGoogleAuthUrl, decodeState, exchangeCodeForTokens } from "./oauth";
import {
  type PBCalendarEvent,
  getCalendarGroup,
  getCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "./pocketbase";
import { syncCalendarForAccount, syncAllCalendars } from "./calendar-sync";
import { runCalendarReminders } from "./calendar-reminders";
import {
  CalendarRouteError,
  createEventCopies,
  deleteEventCopies,
  deleteGroupEverywhere,
  homeGoogleAccountId,
  updateEventCopies,
} from "./calendar-google";
import { encrypt } from "./crypto";
import { randomUUID } from "node:crypto";
import { checkSpam, learnSpam, learnHam, isRspamdAvailable, getRspamdHealth } from "./rspamd";
import { classifyMessage } from "./classifier";
import { getSenderTrust, invalidateSenderTrust } from "./sender-trust";
import {
  searchEmbeddings,
  searchHybridContext,
  startBackfill,
  getBackfillStatus,
  getEmbeddingStats,
  topUpEmbeddingsForAllUsers,
  getCoverage,
  warmCache,
  warmVectorCacheForAllUsers,
} from "./embeddings";
import {
  getSearchMetaByIds,
  checkpointWalIfBloated,
  type SearchMetaRow,
} from "./sqlite-direct";
import { InvalidSearchQueryError, runMailSearch } from "./mail-search";
import { syncSearchIndex, getSearchIndexState } from "./search-index";
import { startHistoryBackfill, getHistoryBackfillStatus, pauseHistoryBackfill } from "./history-backfill";
import {
  getCategoryBackfillStats,
  getCategoryBackfillStatus,
  startCategoryBackfill,
} from "./category-backfill";
import { getBudgetStatus, parisDay, runAsManual, setLimitUsd } from "./ai-budget";
import {
  getCerveauBackfillStats,
  getCerveauBackfillStatus,
  startCerveauAnalysis,
  startCerveauSend,
  pauseCerveauBackfill,
} from "./cerveau-backfill";
import { checkCerveauKey, searchMemory, pushThreadBrief } from "./cerveau";
import {
  startNewsletterBackfill,
  getNewsletterBackfillStatus,
  purgeNewsletterFeed,
} from "./newsletter";
import {
  backfillNewsletterTags,
  getNewsletterStats,
  listKnownTags,
  renameNewsletterTag,
} from "./newsletter-tags";
import { lastWeekWindow, sendWeeklyDigest } from "./newsletter-digest";
import { buildUserDailyDigest, runDailyDigests, sendDailyDigest, windowForToday } from "./daily-digest";
import { buildDailyDigestContent } from "./daily-digest-template";
import {
  purgeTracking,
  trackConversationFromMessage,
  findTrackingCandidates,
  autoProcessMail,
  untrackStarredMessage,
  attachMessagesToTrackingItem,
  startStarredAnalyze,
  getStarredAnalyzeStatus,
  rebuildFicheById,
  estimateRebuildAll,
  startRebuildAll,
  getRebuildAllStatus,
  estimateReprocessRecent,
  startReprocessRecent,
  getReprocessRecentStatus,
  estimateSubjectAnalysis,
  startAnalyzeDates,
  getAnalyzeDatesStatus,
  estimateAnalyzeDates,
  prunePendingSuggestionsAlreadyInAgenda,
  acceptSuggestion,
  refuseSuggestion,
} from "./tracking";
import { scanTrackingAssets } from "./tracking-assets";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp-tools";
import { createApiKey, isApiKeyScope, notifyInactiveApiKeys, resolveApiKey } from "./api-keys";
import { userIdFromAuthToken } from "./pocketbase";
import { ensureContactMemory, listExchangeCandidates } from "./contact-memory";
import {
  getProxiedImage,
  normalizeRemoteUrl,
  pruneImageCache,
  rejectedPlaceholder,
  signImageUrl,
  verifySignedParams,
} from "./image-proxy";

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "10mb",
    // Corps BRUT garde pour les requetes signees par cle d'appareil (/device/*) :
    // la signature porte sur les octets recus, jamais sur un JSON reencode.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

// Plafond des pieces jointes envoyees (compose) : 2 Go, le serveur (VPS propre)
// n'a pas les contraintes d'un hebergeur mutualise. Alignee avec le maxSize
// des champs fichier PocketBase (migration 056).
const ATTACHMENT_MAX_BYTES = Number(
  process.env.MAIL_ATTACHMENT_MAX_BYTES || 2 * 1024 * 1024 * 1024
);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACHMENT_MAX_BYTES } });

const PORT = parseInt(process.env.PORT || "4001", 10);

// Sync locking/status is owned by sync-engine (syncWithLock). Scans stay local.
const activeScans = new Set<string>();

// --- Routes ---

/**
 * POST /sync/:accountId - Trigger IMAP/POP3 sync for an account
 */
app.post("/sync/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
  const accountId = req.params.accountId;

  if (isSyncing(accountId)) {
    res.status(409).json({ error: "Sync already in progress for this account" });
    return;
  }

  const outcome = await syncWithLock(accountId);

  if (outcome.ok) {
    res.json({ success: true, ...outcome.result });
  } else if (outcome.reason === "locked") {
    res.status(409).json({ error: "Sync already in progress for this account" });
  } else if (outcome.reason === "paused") {
    res.status(409).json({ error: "Sync is paused for this user" });
  } else {
    res.status(500).json({ error: outcome.message });
  }
});

// --- Calendar (Agenda) ---

/**
 * POST /calendar/sync/:accountId - Pull Google Calendar (agendas + events) for an
 * account, puis envoie chez Google ce qui n'y est pas encore (agendas propres a
 * iMiel, evenements lus dans les mails, Suivi). Session obligatoire.
 */
app.post("/calendar/sync/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const account = await getAccount(req.params.accountId).catch(() => null);
    if (!account || account.user !== userId) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    const result = await syncCalendarForAccount(req.params.accountId);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const scope = err instanceof Error && err.name === "GoogleCalendarScopeError";
    res.status(scope ? 403 : 500).json({ error: message, needsReconnect: scope });
  }
});

interface CalendarEventBody {
  /** Ignore : l'utilisateur vient du jeton de session (MEM-7465). */
  userId?: string;
  /** Ancien format : un seul agenda. */
  group?: string;
  /** Agendas coches : une copie de l'evenement par agenda. */
  groups?: string[];
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  all_day?: boolean;
  /** Offsets (minutes avant le debut) auxquels notifier. [] => defauts worker. */
  reminders?: number[];
}

function calendarError(res: Response, err: unknown): void {
  const status = err instanceof CalendarRouteError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

/**
 * POST /calendar/event - Cree l'evenement dans chaque agenda coche (une copie
 * par agenda, envoyee chez Google quand l'agenda y est).
 */
app.post("/calendar/event", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const body = req.body as CalendarEventBody;
    const groupIds = Array.isArray(body.groups) && body.groups.length ? body.groups : body.group ? [body.group] : [];
    if (groupIds.length === 0 || !body.title || !body.start || !body.end) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    const copies = await createEventCopies(userId, groupIds, body);
    res.json({ success: true, event: copies[0], copies });
  } catch (err) {
    calendarError(res, err);
  }
});

/**
 * PATCH /calendar/event/:id - Modifie l'evenement et toutes ses copies (et chez
 * Google) ; `groups` fixe l'ensemble des agendas (copies ajoutees / retirees).
 */
app.patch("/calendar/event/:id", async (req: Request<{ id: string }>, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const body = req.body as Partial<CalendarEventBody>;
    const groupIds = Array.isArray(body.groups) ? body.groups : body.group ? [body.group] : undefined;
    const saved = await updateEventCopies(userId, req.params.id, body, groupIds);
    res.json({ success: true, event: saved });
  } catch (err) {
    calendarError(res, err);
  }
});

/**
 * DELETE /calendar/event/:id - Supprime l'evenement et toutes ses copies,
 * partout (iMiel et Google).
 */
app.delete("/calendar/event/:id", async (req: Request<{ id: string }>, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const removed = await deleteEventCopies(userId, req.params.id);
    res.json({ success: true, removed });
  } catch (err) {
    calendarError(res, err);
  }
});

/**
 * POST /calendar/groups/publish - Cree tout de suite chez Google les agendas
 * propres a iMiel (ex. juste apres "Nouvel agenda") et y envoie leurs evenements.
 */
app.post("/calendar/groups/publish", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const home = await homeGoogleAccountId(userId);
    if (!home) {
      res.json({ success: true, google: false });
      return;
    }
    const result = await syncCalendarForAccount(home);
    res.json({ success: true, google: true, ...result });
  } catch (err) {
    calendarError(res, err);
  }
});

/**
 * DELETE /calendar/group/:id - Supprime un agenda partout : chez Google s'il
 * appartient au compte (sinon retire de la liste), puis dans iMiel avec ses
 * evenements. L'agenda principal Google est refuse (400).
 */
app.delete("/calendar/group/:id", async (req: Request<{ id: string }>, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const out = await deleteGroupEverywhere(userId, req.params.id);
    res.json({ success: true, ...out });
  } catch (err) {
    calendarError(res, err);
  }
});

/**
 * Recolle un brouillon de reponse a son message parent avant l'envoi :
 * in_reply_to (depuis draft_reply_to), references (chaine du parent + son
 * Message-ID) et thread_id (herite du parent). Ne touche a rien si le lien est
 * deja complet ou si le parent est introuvable.
 */
async function repairReplyThreading(accountId: string, messageId: string): Promise<void> {
  const msg = await getMessage(messageId);
  const parentMid = msg.in_reply_to || msg.draft_reply_to || "";
  if (!parentMid) return;
  const refs = msg.references || [];
  if (msg.in_reply_to && msg.thread_id && refs.includes(parentMid)) return;
  const parent = await findMessageByMessageId(accountId, parentMid.replace(/"/g, ""));
  const patch: Partial<PBMessage> = {};
  if (!msg.in_reply_to) patch.in_reply_to = parentMid;
  if (!refs.includes(parentMid)) {
    patch.references = [...(parent?.references || []), parentMid].filter(
      (r, i, all) => !!r && all.indexOf(r) === i
    );
  }
  if (!msg.thread_id && parent?.thread_id) patch.thread_id = parent.thread_id;
  if (Object.keys(patch).length > 0) await updateMessageSafe(messageId, patch);
}

/**
 * POST /send - Send email via SMTP
 * Accepts JSON { accountId, messageId } or multipart form-data with files
 */
app.post("/send", upload.array("files"), async (req: Request, res: Response) => {
  const { accountId, messageId } = req.body;

  if (!accountId || !messageId) {
    res.status(400).json({ error: "accountId and messageId are required" });
    return;
  }

  try {
    // Reponse dont le lien au fil s'est perdu (brouillon rouvert puis envoye :
    // in_reply_to/references/thread_id vides, seul draft_reply_to survit).
    // Sans cette reparation, le mail part SANS en-tete In-Reply-To et atterrit
    // dans un fil a part au lieu de la conversation d'origine.
    await repairReplyThreading(accountId, messageId).catch((err) =>
      console.error("[send] repair reply threading error:", err)
    );

    // Upload attached files to PocketBase (worker has admin access)
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    for (const file of uploadedFiles) {
      await createAttachment(messageId, {
        filename: file.originalname,
        contentType: file.mimetype || "application/octet-stream",
        size: file.size,
        content: file.buffer,
      });
    }

    const result = await sendEmail({ accountId, messageId });
    if (result.success) {
      // Suivi de lecture : evenement "envoye" (acceptation SMTP). Non bloquant.
      void recordSentReceipt(messageId);
      // Update message: mark as sent, move to sent folder, compute thread_id
      try {
        const updateData: Partial<PBMessage> = {
          is_draft: false,
          is_sent: true,
          date: new Date().toISOString(),
        };
        if (result.messageId) {
          updateData.message_id = result.messageId;
        }
        // Calculate thread_id if not already set (new messages, not replies)
        const existingMsg = await getMessage(messageId);
        // Extrait du mail envoye : la ligne de conversation affiche la reponse
        // (dernier message du fil), il lui faut un apercu du texte ecrit.
        if (!existingMsg.snippet) {
          const snippet = buildSentSnippet(existingMsg.text_body || "", existingMsg.html_body || "");
          if (snippet) updateData.snippet = snippet;
        }
        if (!existingMsg.thread_id) {
          const newMessageId = result.messageId || existingMsg.message_id;
          if (newMessageId) {
            updateData.thread_id = calculateThreadId({
              messageId: newMessageId,
              inReplyTo: existingMsg.in_reply_to || "",
              references: (existingMsg.references || []).join(" "),
            });
          }
        }
        const account = await getAccount(accountId);
        const folders = await listFolders(accountId);
        const sentFolder = folders.find((f) => f.type === "sent");
        if (sentFolder) {
          updateData.folder = sentFolder.id;
        }
        // updateMessageSafe : fallback merge complet si le PATCH partiel echoue
        // (lock SQLite / race hooks PB renvoie parfois 400). Critique ici :
        // si on rate ce passage en is_draft=false / folder=sent, le mail est
        // envoye via SMTP mais reste dans les brouillons.
        await updateMessageSafe(messageId, updateData);

        // Self-sent emails: create a copy in inbox (SMTP providers like Gmail
        // don't deliver self-sent emails to INBOX via IMAP)
        const senderEmail = account.email.toLowerCase();
        const isSelfSent = existingMsg.to_addresses?.some(
          (addr) => addr.address?.toLowerCase() === senderEmail
        );
        if (isSelfSent) {
          const inboxFolder = folders.find((f) => f.type === "inbox");
          if (inboxFolder) {
            const updatedMsg = await getMessage(messageId);
            await createMessage({
              account: accountId,
              folder: inboxFolder.id,
              message_id: updatedMsg.message_id,
              thread_id: updatedMsg.thread_id,
              subject: updatedMsg.subject,
              from_address: updatedMsg.from_address,
              to_addresses: updatedMsg.to_addresses,
              cc_addresses: updatedMsg.cc_addresses,
              bcc_addresses: updatedMsg.bcc_addresses,
              date: updatedMsg.date,
              snippet: updatedMsg.snippet,
              text_body: updatedMsg.text_body,
              html_body: updatedMsg.html_body,
              is_read: false,
              is_starred: false,
              is_draft: false,
              is_sent: false,
              has_attachments: updatedMsg.has_attachments,
              references: updatedMsg.references,
              in_reply_to: updatedMsg.in_reply_to,
            });
            console.log(`Self-sent email: created inbox copy for ${senderEmail}`);
          }
        }
      } catch (updateErr) {
        console.error("Could not update message after send:", updateErr);
      }

      // Suivi : un mail ENVOYE depuis l'app doit etre pris en compte
      // IMMEDIATEMENT (sans attendre le prochain sync du dossier Envoyes qui
      // passe par syncSentMessage -> autoProcessMail). Couvre : reponse dans un
      // fil deja suivi (refresh + timeline), et nouveau fil sortant rattache a
      // une fiche ouverte par numero d'affaire / sujet. Pas de `notify` : c'est
      // TA propre action, on ne se push pas soi-meme. Non bloquant.
      try {
        const sentMsg = await getMessage(messageId);
        const sentAccount = await getAccount(accountId);
        void autoProcessMail(
          sentAccount.user,
          accountId,
          sentMsg.thread_id,
          sentMsg.id,
          sentMsg.from_address?.address
        ).catch((err) =>
          console.error("[tracking] autoProcess (app-send) error:", err)
        );
        // Journal d'activite : "mes envois" (marque lu : ma propre action).
        void logSentMailActivity({
          userId: sentAccount.user,
          accountId,
          messageId: sentMsg.id,
          threadId: sentMsg.thread_id,
          subject: sentMsg.subject,
          to: sentMsg.to_addresses,
        }).catch((err) =>
          console.warn("[activity] sent log failed:", (err as Error).message)
        );
      } catch (trackErr) {
        console.error("[tracking] autoProcess (app-send) lookup error:", trackErr);
      }
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Send error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /track/open/:token - Pixel de suivi de lecture (public, sans auth).
 * Charge par le client mail du destinataire via l'URL publique de l'app
 * (rewrite Next /worker/*). Verifie le token HMAC, enregistre un evenement
 * "opened" (deduplique) et renvoie TOUJOURS un GIF 1x1 transparent, meme si
 * le token est invalide (ne jamais reveler quoi que ce soit au client).
 */
app.get("/track/open/:token", (req: Request, res: Response) => {
  const parsed = parseTrackingToken(String(req.params.token || ""));
  if (parsed) {
    const forwarded = (req.headers["x-forwarded-for"] as string) || "";
    void recordOpenReceipt({
      messageId: parsed.messageId,
      recipientKey: parsed.recipientKey,
      userAgent: (req.headers["user-agent"] as string) || "",
      ip: forwarded.split(",")[0].trim() || req.socket.remoteAddress || "",
      referer: (req.headers["referer"] as string) || "",
    });
  }
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": String(TRANSPARENT_GIF.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(TRANSPARENT_GIF);
});

/**
 * POST /draft-attachments - Upload files for a draft message
 * Accepts multipart form-data with messageId and files
 */
app.post("/draft-attachments", upload.array("files"), async (req: Request, res: Response) => {
  const { messageId } = req.body;

  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }

  try {
    // Verify the message exists before creating attachments
    try {
      await getMessage(messageId);
    } catch {
      res.status(400).json({ error: `Message ${messageId} not found in PocketBase` });
      return;
    }

    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    const created: { id: string; filename: string; size: number; file: string; content_id: string; is_inline: boolean }[] = [];
    // inline=1 : image placee dans le texte par l'editeur. Elle recoit un
    // Content-ID ; a l'envoi, smtp.ts remplace son URL par cid:<content_id>.
    const inline = String(req.body.inline || "") === "1";

    for (const file of uploadedFiles) {
      const isInline = inline && (file.mimetype || "").toLowerCase().startsWith("image/");
      const att = await createAttachment(messageId, {
        filename: file.originalname,
        contentType: file.mimetype || "application/octet-stream",
        size: file.size,
        content: file.buffer,
        contentId: isInline ? `${randomUUID()}@imiel` : undefined,
        isInline,
      });
      created.push({
        id: att.id,
        filename: att.filename,
        size: att.size,
        file: att.file,
        content_id: att.content_id || "",
        is_inline: !!att.is_inline,
      });
    }

    // Update has_attachments on the message
    if (created.length > 0) {
      await updateMessage(messageId, { has_attachments: true });
    }

    res.json({ success: true, attachments: created });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Draft attachment upload error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /draft-attachments/:id - Remove a draft attachment
 */
app.delete("/draft-attachments/:id", async (req: Request, res: Response) => {
  const attachmentId = req.params.id as string;

  try {
    const att = await getAttachment(attachmentId);
    const msgId = att.message;

    await deleteAttachment(attachmentId);

    // Update has_attachments if no remaining attachments
    const remaining = await getAttachmentsForMessage(msgId);
    if (remaining.length === 0) {
      await updateMessage(msgId, { has_attachments: false });
    }

    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Draft attachment delete error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /test-connection - Test IMAP/SMTP connection
 * Body: { type: "imap" | "smtp", host, port, email, password }
 */
app.post("/test-connection", async (req: Request, res: Response) => {
  const { type, host, port, email, password } = req.body;

  if (!type || !host || !port || !email || !password) {
    res.status(400).json({
      error: "type, host, port, email, and password are required",
    });
    return;
  }

  try {
    let result: { success: boolean; error?: string; folders?: string[] };

    if (type === "imap") {
      result = await testImapConnection({ host, port, email, password });
    } else if (type === "smtp") {
      result = await testSmtpConnection({ host, port, email, password });
    } else {
      res.status(400).json({ error: 'type must be "imap" or "smtp"' });
      return;
    }

    const status = result.success ? 200 : 400;
    res.status(status).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /push - Send push notification
 * Body: { userId, title, body, tag?, data? }
 */
app.post("/push", async (req: Request, res: Response) => {
  const { userId, title, body, tag, data } = req.body;

  if (!userId || !title || !body) {
    res.status(400).json({ error: "userId, title, and body are required" });
    return;
  }

  try {
    const result = await sendPushToUser(userId, { title, body, tag, data });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Push error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /oauth/google/url - Generate Google OAuth2 authorization URL
 * Query: ?userId=xxx
 */
app.get("/oauth/google/url", (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  const origin = (req.query.origin as string) || "";

  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  try {
    const url = generateGoogleAuthUrl(userId, origin || undefined);
    res.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /oauth/google/callback - Handle Google OAuth2 callback
 * Body: { code: string, state: string }
 */
app.post("/oauth/google/callback", async (req: Request, res: Response) => {
  const { code, state } = req.body;

  if (!code || !state) {
    res.status(400).json({ error: "code and state are required" });
    return;
  }

  try {
    // Decode state to get userId + origin (origin needed to rebuild the exact
    // same redirect_uri used to obtain the code).
    const { userId, origin } = decodeState(state);

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, origin || undefined);

    const tokenData = {
      oauth_access_token: encrypt(tokens.access_token),
      oauth_refresh_token: encrypt(tokens.refresh_token),
      oauth_token_expiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };

    // Check if account already exists (reconnection case)
    const existing = await findAccountByEmail(userId, tokens.email);

    let account;
    if (existing) {
      // Reconnect: update tokens and reactivate. On force auth_type=oauth2 +
      // provider : sinon un compte cree a l'origine en mot de passe (app
      // password) garde auth_type="password" et n'est vu ni comme compte
      // Google (onglet Agenda) ni par la sync calendrier (isGoogleOAuthAccount).
      account = await updateAccount(existing.id, {
        ...tokenData,
        auth_type: "oauth2",
        oauth_provider: "google",
        is_active: true,
        sync_status: "idle",
        sync_error: "",
      });
      console.log(`OAuth2 account reconnected: ${tokens.email} (${account.id})`);
    } else {
      // Create new account with Gmail defaults
      account = await createAccount({
        user: userId,
        label: tokens.name || tokens.email,
        email: tokens.email,
        display_name: tokens.name,
        protocol: "imap",
        auth_type: "oauth2",
        oauth_provider: "google",
        ...tokenData,
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_security: "ssl",
        imap_username: tokens.email,
        imap_password: "",
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_username: tokens.email,
        smtp_password: "",
        check_interval: 2,
        is_active: true,
      });
      console.log(`OAuth2 account created: ${tokens.email} (${account.id})`);
    }

    res.json({ success: true, accountId: account.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OAuth2 callback error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /scan-spam/:accountId - Scan existing inbox messages for spam
 * Body: { limit?: number }
 */
app.post("/scan-spam/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
  const accountId = req.params.accountId;
  const limit = Math.min(Number(req.body?.limit) || 200, 500);

  const available = await isRspamdAvailable();
  if (!available) {
    res.status(503).json({ error: "Rspamd is not available" });
    return;
  }

  if (activeScans.has(accountId)) {
    res.status(409).json({ error: "Scan already in progress for this account" });
    return;
  }

  activeScans.add(accountId);

  try {
    const account = await getAccount(accountId);

    // Find inbox and spam folders
    const folders = await listFolders(accountId);
    const inboxFolder = folders.find((f) => f.type === "inbox");
    const spamFolder = await findSpamFolder(accountId);

    if (!inboxFolder) {
      res.status(404).json({ error: "Inbox folder not found" });
      return;
    }
    if (!spamFolder) {
      res.status(404).json({ error: "Spam folder not found. Sync the account first." });
      return;
    }

    // List inbox messages
    const messages = await listMessages(inboxFolder.id, 1, limit);
    if (messages.length === 0) {
      res.json({ scanned: 0, spamDetected: 0, moved: [] });
      return;
    }

    // Fetch raw sources from IMAP
    const uids = messages.map((m) => m.uid).filter((uid) => uid > 0);
    const sources = await fetchMessageSources(account, inboxFolder.path, uids);

    let spamDetected = 0;
    const moved: string[] = [];

    for (const msg of messages) {
      const source = sources.get(msg.uid);
      if (!source) continue;

      const result = await checkSpam(source);
      if (result?.isSpam) {
        try {
          await updateMessageSafe(msg.id, {
            folder: spamFolder.id,
            spam_score: result.score,
            spam_action: result.action,
          });
          spamDetected++;
          moved.push(msg.id);
          console.log(`Scan: spam detected (score=${result.score}): ${msg.subject}`);
        } catch (moveErr) {
          const moveMsg = moveErr instanceof Error ? moveErr.message : String(moveErr);
          console.error(`Scan: failed to move message ${msg.id}: ${moveMsg}`);
        }
      }
    }

    res.json({ scanned: messages.length, spamDetected, moved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Scan-spam error for account ${accountId}:`, message);
    res.status(500).json({ error: message });
  } finally {
    activeScans.delete(accountId);
  }
});

/**
 * POST /rescan-spam-folder/:accountId - Re-analyse le dossier spam des 90
 * derniers jours via le classifieur LLM et rapatrie les faux positifs en
 * boite de reception. Apprentissage Bayes ham best-effort.
 * Body: { days?: number }
 *
 * Reponse : flux NDJSON (1 evenement JSON par ligne) pour suivi temps reel.
 *   { t: "start", total, account }
 *   { t: "item", i, total, subject, from, status: "recovered" | "kept" }
 *   { t: "done", scanned, recovered }
 *   { t: "error", error }
 */
app.post("/rescan-spam-folder/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
  const accountId = req.params.accountId;
  const days = Math.min(Math.max(Number(req.body?.days) || 90, 1), 365);

  if (activeScans.has(accountId)) {
    res.status(409).json({ error: "Scan already in progress for this account" });
    return;
  }

  // Validations pre-flux (peuvent encore renvoyer un status HTTP).
  let account, inboxFolder, spamFolder;
  try {
    account = await getAccount(accountId);
    const folders = await listFolders(accountId);
    inboxFolder = folders.find((f) => f.type === "inbox");
    spamFolder = await findSpamFolder(accountId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
    return;
  }
  if (!inboxFolder) {
    res.status(404).json({ error: "Inbox folder not found" });
    return;
  }
  if (!spamFolder) {
    res.status(404).json({ error: "Spam folder not found. Sync the account first." });
    return;
  }

  activeScans.add(accountId);

  // A partir d'ici, reponse en flux NDJSON.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (evt: Record<string, unknown>): void => {
    res.write(JSON.stringify(evt) + "\n");
  };

  try {
    const accountLabel = account.label || account.email;

    // Messages spam tries par date desc ; on borne aux N derniers jours.
    // Cap remonte a 2000 pour les boites lourdement spammees.
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = await listMessages(
      spamFolder.id,
      1,
      2000,
      "id,uid,subject,date,from_address,snippet,text_body,spam_score"
    );
    const messages = all.filter((m) => {
      const t = new Date(m.date).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });

    send({ t: "start", total: messages.length, account: accountLabel });

    let recovered = 0;
    const recoveredUids: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const senderEmail = msg.from_address?.address || "";
      // Short-circuit whitelist : si l'utilisateur correspond avec cet
      // expediteur, on rapatrie sans appeler le LLM (gratuit + sur).
      const trust = await getSenderTrust(account, senderEmail);
      let status: "recovered" | "kept" = "kept";
      let reason = "";
      // Tente de deplacer un message vers la boite de reception en isolant
      // les echecs PB (partial PATCH 400 sur record stale) : on log et on
      // poursuit le scan sans tuer le flux NDJSON.
      const tryRecover = async (logSuffix: string): Promise<boolean> => {
        try {
          await updateMessageSafe(msg.id, { folder: inboxFolder.id });
          return true;
        } catch (moveErr) {
          const moveMsg =
            moveErr instanceof Error ? moveErr.message : String(moveErr);
          console.error(
            `Rescan: deplacement echoue pour ${msg.id} (${logSuffix}): ${moveMsg}`
          );
          return false;
        }
      };
      if (trust.level === "trusted") {
        reason = `trust=${trust.level} (sent=${trust.sentToCount})`;
        if (await tryRecover(reason)) {
          recovered++;
          status = "recovered";
          if (msg.uid > 0) recoveredUids.push(msg.uid);
          console.log(
            `Rescan: faux positif rapatrie (${reason}): ${msg.subject}`
          );
        }
      } else {
        const verdict = await classifyMessage({
          subject: msg.subject,
          from: msg.from_address || { address: "" },
          bodyText: msg.text_body || msg.snippet || "",
          rspamdScore: msg.spam_score,
          context: {
            sentToCount: trust.sentToCount,
            receivedInboxCount: trust.receivedInboxCount,
            knownDomain: trust.knownDomain,
            inContacts: trust.contactMessageCount > 0,
          },
        });
        // verdict null (LLM indisponible) -> on ne deplace rien (prudent).
        if (verdict && !verdict.spam) {
          reason = verdict.reason;
          if (await tryRecover(`llm: ${reason}`)) {
            recovered++;
            status = "recovered";
            if (msg.uid > 0) recoveredUids.push(msg.uid);
            console.log(
              `Rescan: faux positif rapatrie (rspamd=${msg.spam_score}, trust=${trust.level}): ${msg.subject} -- ${verdict.reason}`
            );
          }
        }
      }
      send({
        t: "item",
        i: i + 1,
        total: messages.length,
        subject: msg.subject || "",
        from: senderEmail,
        status,
      });
    }

    // Apprentissage Bayes ham best-effort sur les mails rapatries.
    if (recoveredUids.length > 0) {
      try {
        if (await isRspamdAvailable()) {
          const sources = await fetchMessageSources(
            account,
            spamFolder.path,
            recoveredUids
          );
          for (const src of sources.values()) {
            await learnHam(src);
          }
        }
      } catch (e) {
        console.warn("Rescan: Bayes ham-learn skipped:", e);
      }
    }

    send({ t: "done", scanned: messages.length, recovered });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Rescan-spam-folder error for account ${accountId}:`, message);
    send({ t: "error", error: message });
    res.end();
  } finally {
    activeScans.delete(accountId);
  }
});

/**
 * POST /spam/learn - Teach Rspamd about spam/ham for Bayes learning
 * Body: { accountId: string, messageId: string, type: "spam" | "ham" }
 */
app.post("/spam/learn", async (req: Request, res: Response) => {
  const { accountId, messageId, type } = req.body;

  if (!accountId || !messageId || !type) {
    res.status(400).json({ error: "accountId, messageId, and type are required" });
    return;
  }

  if (type !== "spam" && type !== "ham") {
    res.status(400).json({ error: 'type must be "spam" or "ham"' });
    return;
  }

  try {
    const account = await getAccount(accountId);
    const message = await getMessage(messageId);

    // Invalidate trust cache : l'utilisateur vient d'enseigner ce sens-la,
    // on veut que la prochaine decision automatique reflete son choix.
    const senderEmail = message.from_address?.address;
    if (senderEmail && account.user) {
      invalidateSenderTrust(account.user, senderEmail);
    }

    const available = await isRspamdAvailable();
    if (!available) {
      // Pas d'erreur dure : le cache trust est invalide, c'est deja un signal.
      res.json({ success: false, reason: "rspamd_unavailable" });
      return;
    }

    // Find the folder to get its IMAP path
    const folders = await listFolders(accountId);
    const folder = folders.find((f) => f.id === message.folder);
    if (!folder) {
      res.status(404).json({ error: "Message folder not found" });
      return;
    }

    // Fetch raw source from IMAP
    const sources = await fetchMessageSources(account, folder.path, [message.uid]);
    const source = sources.get(message.uid);
    if (!source) {
      res.status(404).json({ error: "Could not fetch message source from IMAP" });
      return;
    }

    const success = type === "spam"
      ? await learnSpam(source)
      : await learnHam(source);

    res.json({ success });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Spam learn error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /message-flags/:id - Update is_read/is_starred on a message
 * Uses admin token. Falls back to re-sending full record if partial PATCH fails.
 * Body: { is_read?: boolean, is_starred?: boolean }
 */
app.patch("/message-flags/:id", async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const { is_read, is_starred } = req.body;

  const updates: Partial<PBMessage> = {};
  if (typeof is_read === "boolean") updates.is_read = is_read;
  if (typeof is_starred === "boolean") updates.is_starred = is_starred;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  try {
    // Try simple partial PATCH first
    await updateMessage(id, updates);
    res.json({ success: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`message-flags partial PATCH failed for ${id}:`, errMsg);

    // Fallback: fetch the full record, merge flags, and PUT the whole thing back.
    // This avoids PB validation issues where a partial PATCH triggers re-validation
    // of stale relation fields.
    try {
      const record = await getMessage(id);
      const merged = { ...record, ...updates };
      // Remove read-only fields that PB won't accept on update
      delete (merged as Record<string, unknown>).id;
      delete (merged as Record<string, unknown>).created;
      delete (merged as Record<string, unknown>).updated;
      delete (merged as Record<string, unknown>).collectionId;
      delete (merged as Record<string, unknown>).collectionName;
      await updateMessage(id, merged);
      console.log(`message-flags fallback PUT succeeded for ${id}`);
      res.json({ success: true, fallback: true });
    } catch (err2) {
      const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
      console.error(`message-flags fallback PUT also failed for ${id}:`, errMsg2);
      res.status(500).json({ error: errMsg2 });
    }
  }
});

/**
 * PATCH /message-update/:id - Generic message update with full-record fallback
 * Uses admin token to bypass PB validation issues on partial PATCH.
 * Body: any valid message fields (folder, is_draft, etc.)
 */
app.patch("/message-update/:id", async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const updates = req.body;

  if (!updates || Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  try {
    await updateMessage(id, updates);
    res.json({ success: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`message-update partial PATCH failed for ${id}:`, errMsg);

    // Fallback: full record merge (same pattern as message-flags)
    try {
      const record = await getMessage(id);
      const merged = { ...record, ...updates };
      delete (merged as Record<string, unknown>).id;
      delete (merged as Record<string, unknown>).created;
      delete (merged as Record<string, unknown>).updated;
      delete (merged as Record<string, unknown>).collectionId;
      delete (merged as Record<string, unknown>).collectionName;
      await updateMessage(id, merged);
      console.log(`message-update fallback PUT succeeded for ${id}`);
      res.json({ success: true, fallback: true });
    } catch (err2) {
      const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
      console.error(`message-update fallback PUT also failed for ${id}:`, errMsg2);
      res.status(500).json({ error: errMsg2 });
    }
  }
});

/**
 * DELETE /message-delete/:id - Delete a message using admin token
 */
app.delete("/message-delete/:id", async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  try {
    await deleteMessage(id);
    res.json({ success: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // 404 = already deleted, treat as success
    if (errMsg.includes("404")) {
      res.json({ success: true, alreadyDeleted: true });
      return;
    }
    console.error(`message-delete failed for ${id}:`, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /repair-attachments/:accountId - Re-fetch missing attachments from IMAP
 * For messages with has_attachments=true but no stored attachment records.
 */
app.post("/repair-attachments/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
  const accountId = req.params.accountId;

  try {
    const account = await getAccount(accountId);
    const orphans = await listMessagesWithMissingAttachments(accountId);

    if (orphans.length === 0) {
      res.json({ repaired: 0, failed: 0, noSource: 0 });
      return;
    }

    console.log(`Repair: ${orphans.length} messages with missing attachments for account ${accountId}`);

    // Group by folder for batch IMAP fetching
    const folders = await listFolders(accountId);
    const folderById = new Map(folders.map((f) => [f.id, f]));

    // Group orphan messages by folder path
    const byFolderPath = new Map<string, typeof orphans>();
    for (const msg of orphans) {
      const folder = folderById.get(msg.folder);
      const path = folder?.path || "INBOX";
      const group = byFolderPath.get(path) || [];
      group.push(msg);
      byFolderPath.set(path, group);
    }

    let repaired = 0;
    let failed = 0;
    let noSource = 0;

    for (const [folderPath, msgs] of byFolderPath) {
      const uids = msgs.map((m) => m.uid).filter((uid) => uid > 0);
      if (uids.length === 0) {
        noSource += msgs.length;
        continue;
      }

      let sources: Map<number, Buffer>;
      try {
        sources = await fetchMessageSources(account, folderPath, uids);
      } catch (err) {
        console.error(`Repair: failed to fetch sources from ${folderPath}:`, err);
        failed += msgs.length;
        continue;
      }

      for (const msg of msgs) {
        const source = sources.get(msg.uid);
        if (!source) {
          // Echec de recuperation (UID/dossier obsolete, reseau...) : transitoire,
          // ne prouve pas l'absence de piece jointe -> ne pas toucher has_attachments
          noSource++;
          continue;
        }

        try {
          const parsed = await parseEmail(source);

          if (parsed.attachments.length === 0) {
            // Email parsed but no attachments found — fix the flag
            await updateMessage(msg.id, { has_attachments: false });
            noSource++;
            continue;
          }

          for (const att of parsed.attachments) {
            await createAttachment(msg.id, {
              filename: att.filename,
              contentType: att.contentType,
              size: att.size,
              content: att.content,
              contentId: att.contentId,
              isInline: att.isInline,
            });
          }

          repaired++;
          console.log(`Repair: ${parsed.attachments.length} attachment(s) for "${msg.subject}" (${msg.id})`);
        } catch (err) {
          console.error(`Repair: failed for message ${msg.id}:`, err);
          failed++;
        }
      }
    }

    res.json({ repaired, failed, noSource, total: orphans.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Repair-attachments error for account ${accountId}:`, message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /embeddings/search - Recherche semantique dans les emails indexes
 * Body: { userId, accountId?, query, limit? }
 */
app.post("/embeddings/search", async (req: Request, res: Response) => {
  const { userId, accountId, query, limit } = req.body;
  if (!userId || !query) {
    res.status(400).json({ error: "userId and query are required" });
    return;
  }
  try {
    const results = await searchEmbeddings({
      userId,
      accountId: accountId || undefined,
      query,
      limit: Number(limit) || 8,
    });
    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Embeddings search error:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /embeddings/context - Recherche HYBRIDE (semantique + keyword) +
 * contenu des messages (memoire pour l'assistant IA). Renvoie aussi un
 * snapshot du backfill embeddings pour que le prompt puisse signaler
 * une indexation incomplete a l'utilisateur.
 * Body: { userId, accountId?, query, limit?, mode? }
 *  - mode: "focused" (defaut) ou "wide" (echantillonnage chronologique pour
 *    les questions de synthese / vue d'ensemble).
 */
app.post("/embeddings/context", async (req: Request, res: Response) => {
  const { userId, accountId, query, limit, mode, dateWindow } = req.body;
  if (!userId || !query) {
    res.status(400).json({ error: "userId and query are required" });
    return;
  }
  const t0 = Date.now();
  const safeMode: "focused" | "wide" = mode === "wide" ? "wide" : "focused";
  // Valide la dateWindow : si fournie, doit avoir from et to (YYYY-MM-DD)
  const safeWindow =
    dateWindow &&
    typeof dateWindow.from === "string" &&
    typeof dateWindow.to === "string" &&
    /^\d{4}-\d{2}-\d{2}/.test(dateWindow.from) &&
    /^\d{4}-\d{2}-\d{2}/.test(dateWindow.to)
      ? { from: dateWindow.from, to: dateWindow.to, label: dateWindow.label }
      : undefined;
  console.log(
    `[/embeddings/context] POST user=${userId} account=${
      accountId || "*"
    } limit=${limit ?? "default"} mode=${safeMode}${
      safeWindow ? ` window=${safeWindow.from}..${safeWindow.to}` : ""
    } q="${String(query).slice(0, 200)}"`
  );
  try {
    const lim = Number(limit) || 8;
    const [results, stats] = await Promise.all([
      searchHybridContext({
        userId,
        accountId: accountId || undefined,
        query,
        limit: lim,
        mode: safeMode,
        dateWindow: safeWindow,
      }),
      getEmbeddingStats(userId).catch(() => ({
        totalMessages: 0,
        embedded: 0,
      })),
    ]);
    const backfill = getBackfillStatus(userId);
    console.log(
      `[/embeddings/context] DONE in ${Date.now() - t0}ms -> ${
        results.length
      } hits, indexed=${stats.embedded}/${stats.totalMessages}`
    );
    res.json({
      results,
      indexing: {
        total: stats.totalMessages,
        embedded: stats.embedded,
        backfillRunning: backfill.running,
        backfillDone: backfill.done,
        backfillTotal: backfill.total,
      },
      dateWindow: safeWindow,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[/embeddings/context] FAILED in ${Date.now() - t0}ms:`,
      message
    );
    res.status(500).json({ error: message });
  }
});

/**
 * GET /embeddings/coverage?userId=xxx - Bornes temporelles + total indexes
 * (utilise par /api/ai/chat pour injecter la couverture reelle de la boite
 * dans le system prompt et eviter les hallucinations "rien avant tel mois").
 */
app.get("/embeddings/coverage", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const t0 = Date.now();
  try {
    const coverage = await getCoverage(userId);
    console.log(
      `[/embeddings/coverage] user=${userId} earliest=${coverage.earliestDate} latest=${coverage.latestDate} total=${coverage.totalMessages} indexed=${coverage.indexedMessages} (${Date.now() - t0}ms)`
    );
    res.json(coverage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/embeddings/coverage] ERROR user=", userId, message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /embeddings/warm - Precharge le cache vecteurs pour un user (appele
 * au login ou ouverture du chat). Sans ca, la premiere requete RAG paye le
 * cold-start (~500ms de chargement). Idempotent.
 */
app.post("/embeddings/warm", async (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const result = await warmCache(userId);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/embeddings/warm] ERROR:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /search/hybrid - Recherche HYBRIDE (semantique + FTS5 keyword) pour
 * la barre de recherche UI. Renvoie les IDs ordonnes par score AVEC les
 * metadonnees de liste (sujet, expediteur, extrait, date, type de dossier)
 * quand SQLite direct est disponible : la palette n'a alors AUCUNE
 * rehydratation PB a faire (3 getList paralleles de 1.5-3.7s economises).
 * Sans meta (data.db indispo), le frontend retombe sur l'hydratation PB.
 * Body: { userId, accountId?, query, limit?, sort? }
 */
app.post("/search/hybrid", async (req: Request, res: Response) => {
  const { userId, accountId, query, limit, sort } = req.body;
  if (!userId || !query) {
    res.status(400).json({ error: "userId and query are required" });
    return;
  }
  const t0 = Date.now();
  try {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);

    // sort="date" : requete SIMPLE (mot-cle / nom / adresse, decide cote
    // frontend) -> meme moteur que POST /search/mail (index plein texte du
    // worker, debut de mot, plus recents d'abord, TOUS les mots saisis). Si
    // l'index est indisponible (dev sur PB distante), runMailSearch renvoie
    // null -> on retombe sur le moteur hybride par pertinence.
    let items: Array<{ id: string; score: number } & Partial<SearchMetaRow>> | null =
      null;
    if (sort === "date") {
      const found = await runMailSearch({
        userId,
        accountId: accountId || undefined,
        query,
        perPage: lim,
        sort: "date",
      });
      if (found) {
        items = found.items.map((r) => ({
          score: 1,
          id: r.id,
          thread_id: r.thread_id,
          message_id: r.message_id,
          subject: r.subject,
          from_address: r.from_address,
          to_addresses: r.to_addresses,
          date: r.date,
          snippet: r.snippet,
          has_attachments: r.has_attachments,
          is_read: r.is_read,
          folder: r.folder,
          folder_type: r.folder_type,
        }));
      }
    }

    const stats = await getEmbeddingStats(userId).catch(() => ({
      totalMessages: 0,
      embedded: 0,
    }));

    if (!items) {
      const hits = (
        await searchHybridContext({
          userId,
          accountId: accountId || undefined,
          query,
          limit: lim,
          // Barre de recherche UI : id+score uniquement -> on saute le fetch des
          // corps text_body/html_body (~22 Mo / 200 hits, ~1s -> ~quelques ms).
          lightweight: true,
        })
      ).map((h) => ({ id: h.id, score: h.score }));
      // Attache les metadonnees de liste par lot (une seule requete SQLite,
      // quelques ms). Si indispo -> ids seuls, le frontend rehydrate via PB.
      const metaRows = getSearchMetaByIds(
        userId,
        hits.map((h) => h.id)
      );
      if (metaRows) {
        const metaById = new Map(metaRows.map((m) => [m.id, m]));
        items = hits.map((h) => {
          const meta = metaById.get(h.id);
          return meta ? { score: h.score, ...meta } : h;
        });
      } else {
        items = hits;
      }
    }
    const backfill = getBackfillStatus(userId);
    console.log(
      `[/search/hybrid] DONE in ${Date.now() - t0}ms user=${userId} -> ${
        items.length
      } hits, indexed=${stats.embedded}/${stats.totalMessages}`
    );
    res.json({
      items,
      indexing: {
        total: stats.totalMessages,
        embedded: stats.embedded,
        backfillRunning: backfill.running,
        backfillDone: backfill.done,
        backfillTotal: backfill.total,
      },
    });
  } catch (err) {
    if (err instanceof InvalidSearchQueryError) {
      res.status(400).json({ error: "invalid query", errors: err.errors });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[/search/hybrid] FAILED in ${Date.now() - t0}ms:`,
      message
    );
    res.status(500).json({ error: message });
  }
});

/**
 * POST /search/mail - Recherche de mails pour l'interface : palette (Cmd+K) ET
 * liste "Voir tout", meme moteur, pagination cote serveur, sans plafond.
 * Body: { userId, accountId?, query, page?, perPage?, sort?, scope? }
 *   query : texte saisi tel quel, operateurs compris (from: to: subject:
 *           has:attachment is:unread is:starred after: before:)
 *   scope : perimetre de la liste (view, folderIds, folderType, labelId,
 *           isDraft, excludeSecondary, unread, starred, hasAttachments,
 *           priority, fromText) ; absent = toute la boite (palette)
 * Reponse : { items (forme de /api/mail/list + folder_type), page, perPage,
 *             totalItems, totalPages, counts par type de dossier, mode,
 *             indexing }. 503 si l'index est indisponible (le frontend retombe
 *             alors sur la recherche PocketBase).
 */
app.post("/search/mail", async (req: Request, res: Response) => {
  const { userId, accountId, query, page, perPage, sort, scope } = req.body || {};
  if (!userId || typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "userId and query are required" });
    return;
  }
  const t0 = Date.now();
  try {
    const result = await runMailSearch({
      userId,
      accountId: accountId || undefined,
      query,
      page,
      perPage,
      sort,
      scope: scope && typeof scope === "object" ? scope : undefined,
    });
    if (!result) {
      res.status(503).json({ error: "search index unavailable" });
      return;
    }
    console.log(
      `[/search/mail] ${Date.now() - t0}ms user=${userId} mode=${result.mode} -> ${result.totalItems} resultats (page ${result.page})`
    );
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidSearchQueryError) {
      res.status(400).json({ error: "invalid query", errors: err.errors });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/search/mail] FAILED in ${Date.now() - t0}ms:`, message);
    res.status(500).json({ error: message });
  }
});

/** GET /search/status - Etat de l'index plein texte (construction, taille). */
app.get("/search/status", (_req: Request, res: Response) => {
  res.json(getSearchIndexState());
});

/**
 * POST /embeddings/backfill - Indexe (en arriere-plan) les emails existants
 * Body: { userId }
 */
app.post("/embeddings/backfill", (req: Request, res: Response) => {
  const { userId } = req.body;
  console.log("[/embeddings/backfill] POST userId=", userId);
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startBackfill(userId);
  console.log("[/embeddings/backfill] -> state:", state);
  res.json({ started: true, state });
});

/**
 * GET /embeddings/status?userId=xxx - Statut d'indexation
 */
app.get("/embeddings/status", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const t0 = Date.now();
  try {
    const stats = await getEmbeddingStats(userId);
    const backfill = getBackfillStatus(userId);
    console.log(
      `[/embeddings/status] user=${userId} embedded=${stats.embedded}/${stats.totalMessages} backfill={running=${backfill.running},paused=${backfill.paused},done=${backfill.done}/${backfill.total},err=${backfill.error}} (${Date.now() - t0}ms)`
    );
    res.json({ ...stats, backfill });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/embeddings/status] ERROR user=", userId, message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /categorize/backfill - Categorisation IA des mails inbox des
 * 90 derniers jours sans labels. Body: { userId }
 */
app.post("/categorize/backfill", (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startCategoryBackfill(userId);
  res.json({ started: true, state });
});

/**
 * GET /categorize/status?userId=xxx - Statut + total a categoriser
 */
app.get("/categorize/status", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const stats = await getCategoryBackfillStats(userId);
    res.json({ ...stats, backfill: getCategoryBackfillStatus(userId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Categorize status error:", message);
    res.status(500).json({ error: message });
  }
});

// --- Cerveau (memoire centrale) --------------------------------------------

/** POST /cerveau/analyze - Analyse a blanc (dry-run, ne pousse rien). Body: { userId } */
app.post("/cerveau/analyze", (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startCerveauAnalysis(userId);
  res.json({ started: true, state });
});

/** POST /cerveau/send - Envoi reel des eligibles vers le Cerveau. Body: { userId } */
app.post("/cerveau/send", (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startCerveauSend(userId);
  res.json({ started: true, state });
});

/** POST /cerveau/pause - Met en pause le backfill Cerveau. Body: { userId } */
app.post("/cerveau/pause", (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  res.json({ state: pauseCerveauBackfill(userId) });
});

/** GET /cerveau/status?userId=xxx - Statut + total a pousser */
app.get("/cerveau/status", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const apiKey = await getUserCerveauKey(userId);
    const stats = await getCerveauBackfillStats(userId);
    res.json({
      configured: !!apiKey,
      ...stats,
      backfill: getCerveauBackfillStatus(userId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Cerveau status error:", message);
    res.status(500).json({ error: message });
  }
});

/** POST /cerveau/test - Valide la cle Cerveau de l'utilisateur. Body: { userId } */
app.post("/cerveau/test", async (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const apiKey = await getUserCerveauKey(userId);
    if (!apiKey) {
      res.json({ ok: false, error: "cle Cerveau non configuree" });
      return;
    }
    res.json(await checkCerveauKey(apiKey));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** POST /cerveau/recall - Recherche dans la memoire. Body: { userId, query, k? } */
app.post("/cerveau/recall", async (req: Request, res: Response) => {
  const { userId, query, k, contexte } = req.body as {
    userId?: string;
    query?: string;
    k?: number;
    contexte?: string;
  };
  if (!userId || !query) {
    res.status(400).json({ error: "userId and query are required" });
    return;
  }
  try {
    const apiKey = await getUserCerveauKey(userId);
    if (!apiKey) {
      res.json({ resultats: [] });
      return;
    }
    const resultats = await searchMemory(apiKey, query, k ?? 5, contexte);
    res.json({ resultats });
  } catch (err) {
    console.error("Cerveau recall error:", (err as Error).message);
    res.json({ resultats: [] });
  }
});

// --- Proxy des images des mails (image-proxy.ts) ---
// Signature : jeton PocketBase de l'utilisateur en Authorization (jamais un
// userId declare). Image : URL signee (HMAC + expiration), publique car
// chargee par l'iframe sandboxee du mail, qui n'a pas le jeton.

const imageSignAuthCache = new Map<string, { userId: string; at: number }>();

/** POST /image-proxy/sign - URLs signees des images distantes d'un mail. Body: { urls } -> { signed: { [url]: path } } */
app.post("/image-proxy/sign", async (req: Request, res: Response) => {
  const token = String(req.headers.authorization || "");
  let userId = imageSignAuthCache.get(token);
  if (!userId || Date.now() - userId.at > 5 * 60 * 1000) {
    const id = await userIdFromAuthToken(token).catch(() => null);
    if (!id) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (imageSignAuthCache.size > 500) imageSignAuthCache.clear();
    userId = { userId: id, at: Date.now() };
    imageSignAuthCache.set(token, userId);
  }
  const { urls } = req.body as { urls?: unknown };
  if (!Array.isArray(urls)) {
    res.status(400).json({ error: "urls required" });
    return;
  }
  const signed: Record<string, string> = {};
  for (const raw of urls.slice(0, 300)) {
    if (typeof raw !== "string") continue;
    const url = normalizeRemoteUrl(raw);
    if (url) signed[raw] = signImageUrl(url);
  }
  res.json({ signed });
});

/** GET /image-proxy/img?u=&e=&s= - Image verifiee puis redessinee (WebP), ou cadre neutre. */
app.get("/image-proxy/img", async (req: Request, res: Response) => {
  const url = verifySignedParams(req.query.u, req.query.e, req.query.s);
  if (!url) {
    res.status(403).type("text/plain").send("forbidden");
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const img = await getProxiedImage(url);
    if (img) {
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(img);
      return;
    }
  } catch (err) {
    console.warn("[image-proxy] img:", (err as Error).message);
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.setHeader("X-Image-Rejected", "1");
  res.send(await rejectedPlaceholder());
});

// --- Memoire des contacts (fiche "qui est qui" de l'IA de reponse) ---
// Jeton PocketBase de l'utilisateur en Authorization : ces routes rendent des
// corps de mails et peuvent lancer un appel IA, jamais sur un userId declare.

/** POST /contact-memory/exchanges - Mails de/vers les adresses d'une personne (lecture directe, < 1 s). Body: { addresses, limit? } */
app.post("/contact-memory/exchanges", async (req: Request, res: Response) => {
  const userId = await userIdFromAuthToken(String(req.headers.authorization || "")).catch(() => null);
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { addresses, limit } = req.body as { addresses?: string[]; limit?: number };
  if (!Array.isArray(addresses) || addresses.length === 0) {
    res.status(400).json({ error: "addresses required" });
    return;
  }
  try {
    const out = await listExchangeCandidates(
      userId,
      addresses.filter((a) => typeof a === "string").slice(0, 6),
      Math.min(Math.max(Number(limit) || 60, 1), 120)
    );
    res.json(out);
  } catch (err) {
    console.error("[contact-memory] exchanges:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /contact-memory/ensure - Fiche de la personne a jour (+ fiche Moi, fiches liees). Body: { addresses, name?, participants? } */
app.post("/contact-memory/ensure", async (req: Request, res: Response) => {
  const userId = await userIdFromAuthToken(String(req.headers.authorization || "")).catch(() => null);
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { addresses, name, participants } = req.body as {
    addresses?: string[];
    name?: string;
    participants?: string[];
  };
  if (!Array.isArray(addresses) || addresses.length === 0) {
    res.status(400).json({ error: "addresses required" });
    return;
  }
  try {
    // Demande de l'utilisateur (reponse IA ou bouton de la fiche) : hors plafond automatique.
    const out = await runAsManual(() =>
      ensureContactMemory({
        userId,
        addresses: addresses.filter((a) => typeof a === "string").slice(0, 6),
        name: typeof name === "string" ? name : "",
        participants: Array.isArray(participants) ? participants.filter((a) => typeof a === "string").slice(0, 20) : [],
      })
    );
    console.log(
      `[contact-memory] user=${userId} status=${out.status} new=${out.newMails} others=${out.others.length} in ${out.ms}ms`
    );
    res.json(out);
  } catch (err) {
    console.error("[contact-memory] ensure:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /cerveau/brief - Pousse une note IA de thread. Body: { userId, threadId } */
app.post("/cerveau/brief", async (req: Request, res: Response) => {
  const { userId, threadId } = req.body as { userId?: string; threadId?: string };
  if (!userId || !threadId) {
    res.status(400).json({ error: "userId and threadId are required" });
    return;
  }
  try {
    const apiKey = await getUserCerveauKey(userId);
    if (!apiKey) {
      res.json({ ok: false, error: "cle Cerveau non configuree" });
      return;
    }
    const brief = await getThreadBrief(userId, threadId);
    if (!brief) {
      res.json({ ok: false, error: "note introuvable" });
      return;
    }
    const r = await pushThreadBrief(apiKey, threadId, brief.content);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * POST /newsletters/backfill - Synthese IA des mails des sources designees.
 * Body: { userId, email? } (email pour ne traiter qu'une source precise)
 */
app.post("/newsletters/backfill", (req: Request, res: Response) => {
  const { userId, email } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startNewsletterBackfill(userId, typeof email === "string" ? email : undefined);
  res.json({ started: true, state });
});

/**
 * POST /newsletters/purge - Vide le flux d'un utilisateur. Body: { userId }
 */
app.post("/newsletters/purge", async (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const deleted = await purgeNewsletterFeed(userId);
    res.json({ purged: true, deleted });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Etiquettes, statistiques et resume des newsletters ---
// Proprietaire lu dans le jeton PocketBase (Authorization), jamais dans le corps.

async function authUser(req: Request, res: Response): Promise<string | null> {
  const userId = await userIdFromAuthToken(String(req.headers.authorization || "")).catch(() => null);
  if (!userId) res.status(401).json({ error: "authentication required" });
  return userId;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /newsletters/stats?from=YYYY-MM-DD&to=YYYY-MM-DD (jours de Paris, inclus). */
app.get("/newsletters/stats", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
    res.status(400).json({ error: "from and to (YYYY-MM-DD, from <= to) are required" });
    return;
  }
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (spanDays > 400) {
    res.status(400).json({ error: "period too long (400 days max)" });
    return;
  }
  try {
    res.json(await getNewsletterStats(userId, from, to));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /newsletters/tags - Etiquettes deja employees (suggestions de saisie). */
app.get("/newsletters/tags", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    res.json({ tags: await listKnownTags(userId, 300) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /newsletters/tags/rename { from, to } - Renomme une etiquette sur toutes
 * les newsletters ; un nom deja employe vaut FUSION.
 */
app.post("/newsletters/tags/rename", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  const { from, to } = req.body || {};
  if (typeof from !== "string" || typeof to !== "string" || !from.trim() || !to.trim()) {
    res.status(400).json({ error: "from and to are required" });
    return;
  }
  try {
    res.json(await renameNewsletterTag(userId, from, to));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /newsletters/digest/send - Declenche A LA MAIN le resume de la derniere
 * semaine complete pour l'utilisateur (essai). Au plus une fois par semaine,
 * comme le passage automatique du lundi.
 */
app.post("/newsletters/digest/send", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    res.json(await sendWeeklyDigest(userId, lastWeekWindow()));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /digest/daily/send - Envoie A LA MAIN le recapitulatif du matin (la
 * veille) a l'utilisateur, meme si l'interrupteur est coupe ou s'il est deja
 * parti aujourd'hui (essai). Message-ID unique : chaque essai est un mail.
 */
app.post("/digest/daily/send", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    res.json(await sendDailyDigest(userId, windowForToday(parisDay()), { force: true }));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /digest/daily/preview?day=AAAA-MM-JJ&ai=0 - Apercu HTML du
 * recapitulatif (jour resume = `day`, defaut la veille), SANS rien deposer.
 * `ai=0` force le repli sans IA (aucun cout).
 */
app.get("/digest/daily/preview", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  try {
    const day = typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : "";
    const today = day ? new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : parisDay();
    const { data } = await buildUserDailyDigest(userId, windowForToday(today), { useAi: req.query.ai !== "0" });
    const content = buildDailyDigestContent(data);
    if (req.query.format === "json") {
      res.json({ subject: content.subject, text: content.text, data });
      return;
    }
    res.type("html").send(content.html);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /newsletters/status?userId=xxx - Statut du backfill newsletters
 */
app.get("/newsletters/status", (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  res.json(getNewsletterBackfillStatus(userId));
});

/**
 * GET /tracking/context?userId=xxx - Fiches de suivi compactes (+ derniers
 * evenements) pour le contexte du chat IA. Donnees structurees fiables sur
 * les achats/commandes/livraisons, la ou le RAG email peut se tromper.
 */
app.get("/tracking/context", async (req: Request, res: Response) => {
  const userId = String(req.query.userId || "");
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const fiches = await listTrackingContextForChat(userId);
    res.json({ fiches });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/purge - Vide les fiches de suivi d'un user. Body: { userId }
 */
app.post("/tracking/purge", async (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const deleted = await purgeTracking(userId);
    res.json({ purged: true, deleted });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/analyze-starred - Construit/maj les fiches des conversations
 * ETOILEES recentes + rattache leurs mails lies (timelines d'evolution). Borne.
 * Body: { userId, days? }
 */
app.post("/tracking/analyze-starred", (req: Request, res: Response) => {
  const { userId, days } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const window = typeof days === "number" && days > 0 && days <= 60 ? days : 14;
  const state = startStarredAnalyze(userId, window);
  res.json({ started: true, state });
});

/**
 * GET /tracking/analyze-starred-status?userId=xxx
 */
app.get("/tracking/analyze-starred-status", (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  res.json(getStarredAnalyzeStatus(userId));
});

/**
 * POST /tracking/analyze - Ajoute la CONVERSATION d'un mail au suivi (ou la maj).
 * C'est l'action "Suivre" explicite (decouplee de l'etoile/favori depuis 2026-06-30 :
 * etoiler un mail ne cree plus de fiche, seul ce geste le fait).
 * Body: { userId, messageId } (le userId est implicite via le compte du mail).
 */
app.post("/tracking/analyze", async (req: Request, res: Response) => {
  const { messageId } = req.body;
  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }
  try {
    const result = await runAsManual(() =>
      trackConversationFromMessage(messageId, { gather: true })
    );
    res.json({
      analyzed: true,
      itemId: result?.itemId ?? null,
      created: result?.created ?? false,
      gathered: result?.gathered ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/candidates - Suivis OUVERTS qui ressemblent a la conversation
 * d'un mail, AVANT sa creation (action "Suivre"). Signaux GRATUITS uniquement
 * (numero d'affaire, transporteur, meme correspondant/domaine, vecteurs
 * locaux) : aucun appel OpenRouter. Le front propose alors "Ajouter a ce
 * suivi" ou "Creer un nouveau suivi". Body: { messageId }.
 * Retourne { candidates: [{ id, title, merchant, sender_domain, type,
 * last_message_date, reason }] } (3 au plus, les plus surs en tete).
 */
app.post("/tracking/candidates", async (req: Request, res: Response) => {
  const { messageId } = req.body;
  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }
  try {
    const found = await findTrackingCandidates(messageId);
    res.json({
      candidates: found.map(({ item, reason }) => ({
        id: item.id,
        title: item.title,
        merchant: item.merchant,
        sender_domain: item.sender_domain,
        type: item.type,
        status: item.status,
        last_message_date: item.last_message_date,
        reason,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/untrack - Retire la CONVERSATION d'un mail du suivi (archive la
 * ou les fiches du thread + nettoie agenda/propositions). Action "Ne plus suivre".
 * Body: { messageId } (le userId est implicite via le compte du mail).
 */
app.post("/tracking/untrack", async (req: Request, res: Response) => {
  const { messageId } = req.body;
  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }
  try {
    await untrackStarredMessage(messageId);
    res.json({ untracked: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/attach - Rattache un ou plusieurs mails a une fiche de suivi
 * EXISTANTE (choisie explicitement par l'utilisateur depuis le clic droit ou la
 * selection). Body: { itemId, messageId } ou { itemId, messageIds:[...] }.
 * Une seule re-synthese LLM quel que soit le nombre de mails.
 */
app.post("/tracking/attach", async (req: Request, res: Response) => {
  const { itemId, messageId, messageIds } = req.body;
  const ids: string[] = Array.isArray(messageIds)
    ? messageIds.filter((x): x is string => typeof x === "string")
    : typeof messageId === "string"
      ? [messageId]
      : [];
  if (!itemId || ids.length === 0) {
    res.status(400).json({ error: "itemId and messageId(s) are required" });
    return;
  }
  try {
    await attachMessagesToTrackingItem(ids, itemId);
    res.json({ attached: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/assets/scan - Scanne les PJ images des fils d'une fiche a la
 * recherche de QR codes (jsqr local, SANS LLM, incremental : les PJ deja
 * examinees ne sont pas re-telechargees). Appele a l'ouverture du detail de
 * la fiche cote front. Body: { itemId }. Retourne { assets }.
 */
app.post("/tracking/assets/scan", async (req: Request, res: Response) => {
  const { itemId } = req.body;
  if (!itemId) {
    res.status(400).json({ error: "itemId is required" });
    return;
  }
  try {
    const assets = await scanTrackingAssets(itemId);
    if (!assets) {
      res.status(404).json({ error: "tracking item not found" });
      return;
    }
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /tracking/analyze-estimate?userId=xxx - Cout (GRATUIT a calculer) d'une
 * passe d'analyse PAR SUJET : nb de fiches ouvertes + nb de confirmations IA.
 */
app.get("/tracking/analyze-estimate", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const est = await estimateSubjectAnalysis(userId);
    res.json(est);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /tracking/rebuild-estimate?userId=xxx - Nombre de fiches qui seraient
 * reconstruites (pour annoncer le cout AVANT de lancer la reconstruction).
 */
app.get("/tracking/rebuild-estimate", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const fiches = await estimateRebuildAll(userId);
    res.json({ fiches, maxThreadsPerFiche: 12 });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/rebuild-all - Reconstruit TOUTES les fiches ouvertes (gather
 * des fils lies manquants). Borne + idempotent. Body: { userId }
 */
app.post("/tracking/rebuild-all", (req: Request, res: Response) => {
  const { userId, clean } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startRebuildAll(userId, clean === true);
  res.json({ started: true, state });
});

/**
 * GET /tracking/rebuild-status?userId=xxx - Progression de la reconstruction.
 */
app.get("/tracking/rebuild-status", (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  res.json(getRebuildAllStatus(userId));
});

/**
 * GET /tracking/reprocess-estimate?userId=xxx&days=30 - Nombre de mails inbox de
 * la fenetre qui seraient repasses (annonce du cout AVANT lancement).
 */
app.get("/tracking/reprocess-estimate", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  try {
    const mails = await estimateReprocessRecent(userId, days);
    res.json({ mails, days });
  } catch {
    res.json({ mails: 0, days });
  }
});

/**
 * POST /tracking/reprocess-recent - Repasse les mails inbox des N derniers jours
 * dans le pipeline live (rattachement LLM aux fiches ouvertes). Body: { userId, days? }
 */
app.post("/tracking/reprocess-recent", (req: Request, res: Response) => {
  const { userId, days } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const win = Math.min(Math.max(Number(days) || 30, 1), 90);
  const state = startReprocessRecent(userId, win);
  res.json({ started: true, state });
});

/**
 * GET /tracking/reprocess-status?userId=xxx - Progression de la reprise recente.
 */
app.get("/tracking/reprocess-status", (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  res.json(getReprocessRecentStatus(userId));
});

/**
 * POST /tracking/rebuild-one - Reconstruit UNE fiche (gather de ses fils lies).
 * Body: { itemId }
 */
app.post("/tracking/rebuild-one", async (req: Request, res: Response) => {
  const { itemId, clean } = req.body;
  if (!itemId) {
    res.status(400).json({ error: "itemId is required" });
    return;
  }
  try {
    const attached = await runAsManual(() => rebuildFicheById(itemId, clean === true));
    res.json({ rebuilt: true, attached });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /tracking/dates/estimate?userId=xxx - Nombre de fiches ouvertes qui seront
 * analysees (= nb d'appels LLM). GRATUIT a calculer.
 */
app.get("/tracking/dates/estimate", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const fiches = await estimateAnalyzeDates(userId);
    res.json({ fiches });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/dates/analyze - Analyse les echeances des fiches ouvertes et
 * cree des PROPOSITIONS (pending) ; notif recapitulative a la fin. Body: { userId }
 */
app.post("/tracking/dates/analyze", (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const state = startAnalyzeDates(userId);
  res.json({ started: true, state });
});

/**
 * GET /tracking/dates/analyze-status?userId=xxx - Progression de l'analyse.
 */
app.get("/tracking/dates/analyze-status", (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  res.json(getAnalyzeDatesStatus(userId));
});

/**
 * POST /tracking/dates/prune - Retire les propositions EN ATTENTE deja presentes
 * dans l'agenda (doublons Google/ICS/manuel). Aucun appel LLM. Body: { userId }
 */
app.post("/tracking/dates/prune", async (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const removed = await prunePendingSuggestionsAlreadyInAgenda(userId);
    res.json({ pruned: removed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/dates/:id/accept - Valide une proposition -> cree l'event dans
 * l'agenda (groupe "Suivi"). Idempotent.
 */
app.post("/tracking/dates/:id/accept", async (req: Request<{ id: string }>, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  try {
    const s = await acceptSuggestion(id);
    if (!s) {
      res.status(404).json({ error: "suggestion not found" });
      return;
    }
    res.json({ accepted: true, suggestion: s });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /tracking/dates/:id/refuse - Refuse une proposition (rien ajoute a l'agenda).
 */
app.post("/tracking/dates/:id/refuse", async (req: Request<{ id: string }>, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  try {
    const s = await refuseSuggestion(id);
    if (!s) {
      res.status(404).json({ error: "suggestion not found" });
      return;
    }
    res.json({ refused: true, suggestion: s });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});


// --- Connectivite : cles d'API + connecteur MCP en ligne ---

/**
 * POST /api-keys - Cree une cle d'API. Authorization = jeton PocketBase de
 * l'utilisateur (le proprietaire est lu dans le jeton, jamais dans le corps).
 * Body: { name, scope: "read"|"full" }. Rend la cle ENTIERE une seule fois.
 * Liste et suppression passent directement par PocketBase (regles proprietaire).
 */
app.post("/api-keys", async (req: Request, res: Response) => {
  try {
    const userId = await userIdFromAuthToken(String(req.headers.authorization || ""));
    if (!userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const { name, scope } = req.body || {};
    if (!isApiKeyScope(scope) || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name and scope (read|full) are required" });
      return;
    }
    const { key, record } = await createApiKey(userId, name, scope);
    res.json({ key, id: record.id, name: record.name, scope: record.scope, prefix: record.prefix });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /mcp - Connecteur MCP en ligne (Streamable HTTP, SANS etat, reponses
 * JSON : rien ne reste ouvert, le relais Next /worker/* suffit).
 * Authorization: Bearer hkm_... ; une cle "read" ne voit que les outils de
 * lecture. Adresse publique : https://<app>/worker/mcp
 */
app.post("/mcp", async (req: Request, res: Response) => {
  let resolved;
  try {
    resolved = await resolveApiKey(req.headers.authorization);
  } catch (err) {
    console.error("[mcp] key lookup failed:", (err as Error).message);
    res.status(503).json({ jsonrpc: "2.0", error: { code: -32603, message: "service unavailable" }, id: null });
    return;
  }
  if (!resolved) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="imiel"')
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "invalid or missing API key" }, id: null });
    return;
  }
  const server = buildMcpServer({ userId: resolved.userId, userToken: resolved.userToken, scope: resolved.scope });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
});

// Mode sans etat : ni flux GET ni fermeture de session.
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

/**
 * POST /history-backfill/:accountId - Rapatrie tout l'historique IMAP
 * (au-dela des 500 derniers messages de la sync initiale). En arriere-plan.
 */
app.post(
  "/history-backfill/:accountId",
  (req: Request<{ accountId: string }>, res: Response) => {
    const accountId = req.params.accountId;
    if (!accountId) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const state = startHistoryBackfill(accountId);
    res.json({ started: true, state });
  }
);

/**
 * GET /history-backfill/status/:accountId - Statut du rapatriement historique
 */
app.get(
  "/history-backfill/status/:accountId",
  (req: Request<{ accountId: string }>, res: Response) => {
    const accountId = req.params.accountId;
    res.json(getHistoryBackfillStatus(accountId));
  }
);

/**
 * POST /history-backfill/pause/:accountId - Met en pause le rapatriement (le
 * progres est conserve, le job s'arrete au prochain batch).
 */
app.post(
  "/history-backfill/pause/:accountId",
  (req: Request<{ accountId: string }>, res: Response) => {
    const accountId = req.params.accountId;
    const state = pauseHistoryBackfill(accountId);
    res.json({ paused: true, state });
  }
);

/**
 * GET /health - Health check
 */
app.get("/health", async (_req: Request, res: Response) => {
  const rspamd = await getRspamdHealth();
  const engine = getEngineStatus();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    activeSyncs: engine.activeSyncs,
    activeScans: activeScans.size,
    idleAccounts: engine.idleAccounts,
    idleHealthy: engine.idleHealthy,
    syncStates: getAllSyncStates(),
    rspamd,
    timestamp: new Date().toISOString(),
  });
});

// --- Budget IA (plafond journalier OpenRouter) ---

/** GET /ai-budget - Depense IA du jour, plafond, etat et heure de levee. */
app.get("/ai-budget", (_req: Request, res: Response) => {
  res.json(getBudgetStatus());
});

/** POST /ai-budget {limitUsd: number|null} - Regle le plafond (null = defaut env). */
app.post("/ai-budget", (req: Request, res: Response) => {
  const raw = (req.body || {}).limitUsd;
  if (raw !== null && !(typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1000)) {
    res.status(400).json({ error: "limitUsd must be a number between 0 and 1000, or null" });
    return;
  }
  setLimitUsd(raw);
  res.json(getBudgetStatus());
});

// --- Error handling ---

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- Start ---

import http from "http";
import { initWsHub } from "./ws-hub";

const server = http.createServer(app);
initWsHub(server);

// Rattrapage automatique des embeddings : un mail qui a echoue lors de
// l'indexation incrementale (worker redemarre, exception, modele timeout)
// n'est jamais reindexe sans intervention manuelle. Ce cron scanne tous
// les utilisateurs actifs et relance le backfill (idempotent) des qu'il
// trouve au moins un mail non indexe.
const EMBEDDINGS_TOPUP_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const EMBEDDINGS_TOPUP_FIRST_DELAY_MS = 60_000; // attend 1 min au boot

// PAS de rattrapage automatique de la categorisation IA : l'ancien cron
// (90 s apres le boot puis toutes les 10 min) renvoyait a OpenRouter les mails
// inbox recents restes sans label, y compris ceux que le LLM avait refuses ->
// un meme mail repartait ~12 fois et chaque deploiement tirait une rafale
// payante. Le classement de masse reste possible via POST /categorize/backfill
// (bouton des reglages), sous le plafond journalier (ai-budget.ts).

// Pull Google Calendar : sync incremental (syncToken) de tous les comptes
// Google actifs. Cron leger (le pull incremental ne renvoie que les deltas).
const CALENDAR_SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 min
const CALENDAR_SYNC_FIRST_DELAY_MS = 20_000; // 20s au boot

// Rappels d'evenements : resolution a la minute (les offsets sont en minutes).
const CALENDAR_REMINDERS_INTERVAL_MS = 60 * 1000; // 1 min
const CALENDAR_REMINDERS_FIRST_DELAY_MS = 30_000; // 30s au boot

// Detecteur de blocage de l'event loop : tout code SYNCHRONE long (scans
// better-sqlite3 a froid, tokenisation embeddings...) gele TOUTES les
// operations en vol (ex: un SELECT INBOX Gmail mesure a 40s alors que Gmail
// repond en 475ms). Ce log borne le moment du blocage pour incriminer le
// coupable dans la timeline.
let lagLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lagLast - 1000;
  if (lag > 1000) {
    console.warn(
      `[lag] event loop bloquee ~${lag}ms (fin ${new Date(now).toISOString()})`
    );
  }
  lagLast = now;
}, 1000);

// Cache disque du proxy d'images : purge au demarrage puis toutes les 6 h.
void pruneImageCache();
setInterval(() => { void pruneImageCache(); }, 6 * 3600 * 1000).unref();

/**
 * POST /calendar/invitations/:id/respond  body: { response: accepted|declined|tentative }
 * Session PocketBase OBLIGATOIRE (Authorization) : l'utilisateur vient du jeton,
 * jamais du corps, et l'evenement doit lui appartenir (MEM-7465). La reponse
 * part a l'organisateur (Google si l'evenement y est, sinon mail iMIP).
 */
app.post("/calendar/invitations/:id/respond", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  const response = String((req.body || {}).response || "");
  if (response !== "accepted" && response !== "declined" && response !== "tentative") {
    res.status(400).json({ error: "response must be accepted, declined or tentative" });
    return;
  }
  try {
    const out = await respondToInvitation(userId, String(req.params.id), response);
    res.json({ ok: true, sentVia: out.sentVia, event: out.event });
  } catch (err) {
    const status = err instanceof InvitationError ? err.status : 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Application iPhone : cles d'appareil signees (widgets, actions de notif).
// Signature : X-Device-Sig = hex(HMAC(secret, "<ts>.<id>.<sha256 hex de
// "<METHODE> <chemin sans /worker ni query>\n<corps brut>">")), X-Device-Ts en ms.
// ---------------------------------------------------------------------------

function deviceCanonical(req: Request): Buffer {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody || Buffer.alloc(0);
  return Buffer.concat([Buffer.from(`${req.method.toUpperCase()} ${req.path}\n`), raw]);
}

async function deviceUser(req: Request, res: Response): Promise<{ userId: string; keyRecordId: string } | null> {
  const out = await authenticateDeviceRequest(
    {
      id: String(req.headers["x-device-id"] || ""),
      ts: String(req.headers["x-device-ts"] || ""),
      sig: String(req.headers["x-device-sig"] || ""),
    },
    deviceCanonical(req)
  );
  if ("status" in out) {
    res.status(401).json({ error: out.reason });
    return null;
  }
  return out;
}

/** POST /device/keys (SESSION PocketBase) : emet la cle de cet appareil, rendue une seule fois. */
app.post("/device/keys", async (req: Request, res: Response) => {
  const userId = await authUser(req, res);
  if (!userId) return;
  const body = (req.body || {}) as { platform?: string; deviceName?: string };
  try {
    const key = await issueDeviceKey(userId, {
      platform: String(body.platform || "ios"),
      deviceName: String(body.deviceName || ""),
    });
    res.json({ deviceId: key.deviceId, secret: key.secret });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** DELETE /device/keys/current (signee) : deconnexion de l'appareil. */
app.delete("/device/keys/current", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  await revokeDeviceKey(dev.userId, dev.keyRecordId).catch(() => {});
  res.json({ ok: true });
});

/** POST /device/push-token (signee) : jeton APNs de l'appareil. body { token, environment } */
app.post("/device/push-token", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  const body = (req.body || {}) as { token?: string; environment?: string; deviceName?: string };
  const token = String(body.token || "").toLowerCase();
  if (!/^[0-9a-f]{32,200}$/.test(token)) {
    res.status(400).json({ error: "invalid APNs token" });
    return;
  }
  const host = body.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  try {
    await upsertApnsToken(dev.userId, dev.keyRecordId, `https://${host}/3/device/${token}`, String(body.deviceName || "iPhone"));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function widgetRange(req: Request): { from: string; to: string } {
  const now = Date.now();
  const f = Date.parse(String(req.query.from || ""));
  const t = Date.parse(String(req.query.to || ""));
  const from = Number.isFinite(f) ? f : now - 24 * 3600_000;
  const to = Number.isFinite(t) && t > from && t - from <= 62 * 86400_000 ? t : from + 15 * 86400_000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** GET /device/widgets (signee) : agenda + importants + suivis en UNE requete. */
app.get("/device/widgets", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  const { from, to } = widgetRange(req);
  try {
    const [agenda, important, tracking] = await Promise.all([
      widgetAgenda(dev.userId, from, to),
      widgetImportant(dev.userId),
      widgetTracking(dev.userId),
    ]);
    res.json({ generatedAt: new Date().toISOString(), agenda, important, tracking });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/device/widgets/agenda", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  const { from, to } = widgetRange(req);
  res.json({ agenda: await widgetAgenda(dev.userId, from, to).catch(() => []) });
});

app.get("/device/widgets/important", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  res.json({ important: await widgetImportant(dev.userId).catch(() => ({ count: 0, items: [] })) });
});

app.get("/device/widgets/tracking", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  res.json({ tracking: await widgetTracking(dev.userId).catch(() => ({ moved: 0, items: [] })) });
});

/** POST /device/invitations/:id/respond (signee) : meme chemin que la session. */
app.post("/device/invitations/:id/respond", async (req: Request, res: Response) => {
  const dev = await deviceUser(req, res);
  if (!dev) return;
  const response = String((req.body || {}).response || "");
  if (response !== "accepted" && response !== "declined" && response !== "tentative") {
    res.status(400).json({ error: "response must be accepted, declined or tentative" });
    return;
  }
  try {
    const out = await respondToInvitation(dev.userId, String(req.params.id), response);
    res.json({ ok: true, sentVia: out.sentVia, status: out.event.invitation_status });
  } catch (err) {
    const status = err instanceof InvitationError ? err.status : 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`mail-worker listening on port ${PORT}`);
  console.log(`PocketBase URL: ${process.env.POCKETBASE_URL || "http://127.0.0.1:8090"}`);
  startSyncEngine();

  // Premier scan apres 60s (laisse le boot finir, evite de tirer au sync
  // initial). Puis toutes les 15 min en regime stable.
  setTimeout(() => {
    void topUpEmbeddingsForAllUsers();
    setInterval(() => {
      void topUpEmbeddingsForAllUsers();
    }, EMBEDDINGS_TOPUP_INTERVAL_MS);
  }, EMBEDDINGS_TOPUP_FIRST_DELAY_MS);

  // Pre-chauffe le cache vecteurs de recherche au boot (45s, apres le sync
  // initial) puis toutes les 20 min (< TTL 30 min) : la barre de recherche ne
  // paie jamais les ~6s de chargement a froid des 36k vecteurs.
  setTimeout(() => {
    void warmVectorCacheForAllUsers();
    setInterval(() => {
      void warmVectorCacheForAllUsers();
    }, 20 * 60 * 1000);
  }, 45_000);

  // Index de recherche plein texte (search-index.ts) : premiere passe a 20s
  // (construction complete apres une mise en ligne, en tache de fond), puis
  // toutes les minutes. Une passe ou rien n'a change dans data.db ne coute
  // qu'un PRAGMA ; la recherche rattrape de toute facon les nouveaux mails.
  setTimeout(() => {
    void syncSearchIndex();
    setInterval(() => {
      void syncSearchIndex();
    }, 60 * 1000);
  }, 20_000);

  // Pull periodique Google Calendar -> events locaux (incremental).
  setTimeout(() => {
    void syncAllCalendars();
    setInterval(() => {
      void syncAllCalendars();
    }, CALENDAR_SYNC_INTERVAL_MS);
  }, CALENDAR_SYNC_FIRST_DELAY_MS);

  // Rappels d'evenements (push) : scan toutes les minutes des events a venir,
  // tire les alertes dues (offset utilisateur ou defauts 9h/3h/30min).
  setTimeout(() => {
    void runCalendarReminders();
    setInterval(() => {
      void runCalendarReminders();
    }, CALENDAR_REMINDERS_INTERVAL_MS);
  }, CALENDAR_REMINDERS_FIRST_DELAY_MS);

  // Garde-fou WAL : si data.db-wal depasse 256 Mo (checkpoints SQLite
  // affames par le churn), tente un TRUNCATE. Cf sqlite-direct.ts.
  setTimeout(() => {
    checkpointWalIfBloated();
    setInterval(() => {
      checkpointWalIfBloated();
    }, 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Retention du journal d'activite : purge les entrees > 35 jours (le centre
  // de notifications n'affiche que 30j). Premier passage a +2min, puis 24h.
  setTimeout(() => {
    void pruneActivitiesOlderThan(35).then((n) => {
      if (n > 0) console.log(`[activity] prune: ${n} entrees supprimees`);
    });
    setInterval(() => {
      void pruneActivitiesOlderThan(35);
    }, 24 * 60 * 60 * 1000);
  }, 2 * 60 * 1000);

  // Etiquettes des newsletters des 90 derniers jours (rattrapage une seule fois
  // par synthese, tags_done) : +3 min puis toutes les 6 h pour les restes.
  setTimeout(() => {
    void backfillNewsletterTags().catch((err) => console.warn("[newsletter-tags] backfill failed:", (err as Error).message));
    setInterval(() => {
      void backfillNewsletterTags().catch((err) => console.warn("[newsletter-tags] backfill failed:", (err as Error).message));
    }, 6 * 60 * 60 * 1000);
  }, 3 * 60 * 1000);

  // Recapitulatif du matin : verification toutes les 15 min (envoi des 7 h
  // Paris, rattrapage jusqu'a midi ; au plus une fois par jour et par
  // utilisateur). Le lundi, il absorbe le resume hebdomadaire des newsletters
  // ("sujets qui montent") : runWeeklyDigests NE PART PLUS automatiquement.
  setTimeout(() => {
    void runDailyDigests().catch((err) => console.warn("[daily-digest] run failed:", (err as Error).message));
    setInterval(() => {
      void runDailyDigests().catch((err) => console.warn("[daily-digest] run failed:", (err as Error).message));
    }, 15 * 60 * 1000);
  }, 4 * 60 * 1000);

  // Tri en trois niveaux : rattrapage UNIQUE des 30 derniers jours (drapeau
  // persistant, borne, sous le plafond IA journalier). Sans effet une fois fait.
  setTimeout(() => {
    void runImportanceBackfillOnce().catch((err) => console.warn("[importance-backfill] failed:", (err as Error).message));
  }, 6 * 60 * 1000);

  // Cles d'API restees 30 jours sans servir : UNE notification par periode de
  // silence (api-keys.ts). Premier passage a +5 min, puis toutes les 6 h.
  setTimeout(() => {
    void notifyInactiveApiKeys().catch((err) => console.warn("[api-keys] check failed:", (err as Error).message));
    setInterval(() => {
      void notifyInactiveApiKeys().catch((err) => console.warn("[api-keys] check failed:", (err as Error).message));
    }, 6 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
});
