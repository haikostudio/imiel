import { ImapFlow, MailboxObject, FetchMessageObject } from "imapflow";
import { isDigestMessageId } from "./digest-id";
import { decrypt } from "./crypto";
import { parseEmail } from "./parser";
import { calculateThreadId } from "./threading";
import { sendNewEmailNotification } from "./push";
import { logNewMailActivity } from "./activity";
import { getValidAccessToken } from "./oauth";
import {
  type PBAccount,
  type PBFolder,
  getAccount,

  listFolders,
  upsertFolder,
  updateFolder,
  createMessage,
  createAttachment,
  listExistingMessageIds,
  listExistingUidsForFolder,
  listExistingUidsAmong,
  messageIdExists,
  getLastUidForFolder,
  countRecords,
} from "./pocketbase";
import { checkSpam } from "./rspamd";
import { classifyMessage } from "./classifier";
import { categorizeMessageFull } from "./categorizer";
import { decideImportance, importanceAllowsNotification, type Importance } from "./importance";
import { isDesignatedSource, processNewsletter } from "./newsletter";
import { autoProcessMail } from "./tracking";
import { listLabelNames, resolveLabelIds, loadThreadLabelOverrides, hasAnySecondaryLabel } from "./labels";
import { enqueueEmbedding } from "./embeddings";
import { aggregateMailIfReal } from "./cerveau";
import { importIcsFromEmail } from "./ics";
import { getSenderTrust } from "./sender-trust";
import { updateMessage, getUserOpenRouterKey, getUserNotificationsEnabled, getUserBlockedSenders, isLaterCopyOfMailOnOtherAccount, getImportanceContext } from "./pocketbase";
import type { ParsedEmail } from "./parser";

interface ImapConnectionConfig {
  host: string;
  port: number;
  auth: {
    user: string;
    pass?: string;
    accessToken?: string;
  };
  secure: boolean;
  logger: false;
  socketTimeout: number;
}

export async function buildImapConfig(account: PBAccount): Promise<ImapConnectionConfig> {
  if (account.auth_type === "oauth2") {
    const accessToken = await getValidAccessToken(account);
    return {
      host: account.imap_host,
      port: account.imap_port,
      auth: {
        user: account.imap_username || account.email,
        accessToken,
      },
      secure: account.imap_port === 993,
      logger: false,
      socketTimeout: 120_000,
    };
  }

  const password = decrypt(account.imap_password);
  return {
    host: account.imap_host,
    port: account.imap_port,
    auth: {
      user: account.imap_username || account.email,
      pass: password,
    },
    secure: account.imap_port === 993,
    logger: false,
    socketTimeout: 120_000,
  };
}

/** App-native folder types. No IMAP folder sync — the app manages its own folders. */
const APP_FOLDERS = ["inbox", "sent", "drafts", "trash", "spam"] as const;

/**
 * Ensure app-native folders exist in PocketBase for the given account.
 * Does NOT read IMAP folders — all classification is done by the app.
 */
async function ensureAppFolders(
  accountId: string
): Promise<Record<string, PBFolder>> {
  const existingFolders = await listFolders(accountId);
  const byType = new Map(existingFolders.map(f => [f.type, f]));

  const folders: Record<string, PBFolder> = {};

  for (const type of APP_FOLDERS) {
    let folder = byType.get(type);
    if (!folder) {
      folder = await upsertFolder(accountId, {
        name: type,
        path: type,
        type,
        delimiter: "/",
      });
    }
    folders[type] = folder;
  }

  return folders;
}

/**
 * How many messages to fetch on initial sync (most recent first).
 */
const INITIAL_SYNC_COUNT = 500;

/**
 * Batch size for incremental sync fetch+process. Small so the IMAP connection
 * is never held open for long during the heavy per-message work below.
 */
const SYNC_BATCH_SIZE = 25;

/**
 * En dessous de ce nombre de candidats, la sync est traitee en "hot path
 * live" : dedup par requetes point indexees (uid IN + message_id) au lieu de
 * precharger les sets complets du dossier (couteux et bloquant a froid).
 */
const SMALL_SYNC_MAX = 200;
// Rattrapage (reconnexion IDLE / redemarrage du worker) : au-dela de ce nombre
// de mails retrouves d'un coup, on les enregistre SANS aucun appel LLM (spam,
// categorisation, suivi, taches, Cerveau, newsletters), comme une synchro
// initiale. Un mail plus vieux que LIVE_LLM_MAX_AGE_MS a sa reception n'est pas
// "live" non plus : chaque deploiement tirait sinon une rafale payante.
const LIVE_LLM_MAX_CANDIDATES = 10;
const LIVE_LLM_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Resolve the ascending list of candidate UIDs a folder needs to cover, i.e.
 * everything strictly above `lastUid`. On the very first sync (`lastUid === 0`)
 * only the most recent INITIAL_SYNC_COUNT messages are taken. `bulkInitial` is
 * true when this is that initial mass import (used to skip LLM classification).
 */
async function resolveCandidateUids(
  client: ImapFlow,
  lastUid: number,
  label: string
): Promise<{ candidates: number[]; bulkInitial: boolean }> {
  if (lastUid > 0) {
    const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
    const candidates = (Array.isArray(found) ? (found as number[]) : [])
      .filter((u) => u > lastUid)
      .sort((a, b) => a - b);
    return { candidates, bulkInitial: false };
  }

  const all = await client.search({ all: true }, { uid: true });
  const allUids = (Array.isArray(all) ? (all as number[]) : []).sort(
    (a, b) => a - b
  );
  const candidates =
    allUids.length > INITIAL_SYNC_COUNT
      ? allUids.slice(allUids.length - INITIAL_SYNC_COUNT)
      : allUids;
  const bulkInitial = candidates.length > 0;
  if (bulkInitial) {
    console.log(
      `Initial sync ${label}: ${candidates.length} most recent message(s) of ${allUids.length} (LLM classify skipped)`
    );
  }
  return { candidates, bulkInitial };
}

/**
 * Fetch the given candidate UIDs (ascending, already > lastUid) in small
 * batches and process each new message OUTSIDE the IMAP fetch stream.
 *
 * Why batched + drained: doing Rspamd + LLM classification + PocketBase writes
 * + attachment uploads while a `client.fetch` generator is still open keeps the
 * IMAP connection busy/slow, and Gmail then drops it ("Connection not
 * available"). Draining each small batch fully before processing — with a NOOP
 * between batches — keeps the connection healthy. `last_uid` is persisted after
 * every completed batch, so a mid-stream drop resumes cleanly on the next sync.
 *
 * `existingUids` is consulted to skip already-stored UIDs (no refetch) while
 * still advancing `last_uid` past them.
 */
async function fetchProcessRange(
  client: ImapFlow,
  candidates: number[],
  existingUids: Set<number>,
  folderId: string,
  lastUid: number,
  processOne: (msg: FetchMessageObject) => Promise<boolean>,
): Promise<{ maxUid: number; inserted: number }> {
  let maxUid = lastUid;
  let inserted = 0;
  const fetchOpts = {
    uid: true,
    flags: true,
    envelope: true,
    source: true,
    bodyStructure: true,
  } as const;

  for (let i = 0; i < candidates.length; i += SYNC_BATCH_SIZE) {
    const slice = candidates.slice(i, i + SYNC_BATCH_SIZE);
    const toFetch = slice.filter((u) => !existingUids.has(u));

    if (toFetch.length > 0) {
      // a) Drain the batch sources into memory (the stream closes immediately,
      //    so the connection is never idle mid-FETCH during processing).
      const messages: FetchMessageObject[] = [];
      for await (const msg of client.fetch(toFetch, fetchOpts, { uid: true })) {
        messages.push(msg as FetchMessageObject);
      }
      // b) Heavy processing happens with no IMAP fetch in flight.
      for (const msg of messages) {
        try {
          const ins = await processOne(msg);
          existingUids.add(msg.uid);
          if (ins) inserted++;
        } catch (err) {
          console.error(`Error processing message UID ${msg.uid}:`, err);
        }
      }
    }

    // Whole slice covered (processed + already-existing) -> advance + persist.
    maxUid = slice[slice.length - 1];
    await updateFolder(folderId, { last_uid: maxUid }).catch(() => {});

    // c) Keepalive during the processing pause before the next batch.
    if (i + SYNC_BATCH_SIZE < candidates.length) {
      await client.noop().catch(() => {});
    }
  }

  return { maxUid, inserted };
}

/**
 * Sync messages from IMAP INBOX into app-native folders.
 * Only reads INBOX on the IMAP server. Messages are classified
 * into app folders (inbox/spam) by Rspamd and filter rules.
 */
async function syncInbox(
  client: ImapFlow,
  account: PBAccount,
  appFolders: Record<string, PBFolder>,
): Promise<number> {
  const inboxFolder = appFolders["inbox"];

  const tLock = Date.now();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const mailbox = client.mailbox as MailboxObject;
    if (!mailbox) return 0;
    const tOpen = Date.now();

    // Get last synced UID for the inbox folder
    const lastUid = inboxFolder.last_uid || (await getLastUidForFolder(inboxFolder.id));

    // Skip if already fully synced (uidNext is the next UID the server will assign)
    const uidNext = (mailbox as any).uidNext as number | undefined;
    if (lastUid > 0 && uidNext && lastUid >= uidNext - 1) {
      const status = await client.status("INBOX", {
        messages: true,
        unseen: true,
      });
      await updateFolder(inboxFolder.id, {
        total_count: status.messages || 0,
        unread_count: status.unseen || 0,
        last_uid: lastUid,
      });
      return 0;
    }

    // Candidats D'ABORD (recherche IMAP legere) : le cas courant live est
    // 0-quelques mails, inutile de precharger les gros sets de dedup.
    const tSearch = Date.now();
    const { candidates, bulkInitial } = await resolveCandidateUids(
      client,
      lastUid,
      "INBOX"
    );

    // Hot path live (peu de candidats) : dedup par requetes POINT indexees.
    // Le prechargement complet (33k message-ids + 33k uids via index non
    // couvrant -> row fetches dans une table de 2.3 Go) gelait l'event loop
    // du worker ~25 s a froid A CHAQUE mail entrant.
    const smallSync = !bulkInitial && candidates.length <= SMALL_SYNC_MAX;

    const tIds = Date.now();
    // Load existing message IDs (across ALL app folders to avoid duplicates)
    const existingMessageIds = smallSync
      ? new Set<string>()
      : await listExistingMessageIds(account.id, inboxFolder.id);
    const tUids = Date.now();
    // UID dedup: stable per IMAP mailbox, catches mail with no Message-ID
    const existingUids = smallSync
      ? await listExistingUidsAmong(inboxFolder.id, candidates)
      : await listExistingUidsForFolder(inboxFolder.id);

    const tFetch = Date.now();
    if (candidates.length > 0) {
      console.log(
        `[sync] INBOX ${account.email}: open=${tOpen - tLock}ms search=${tIds - tSearch}ms ids=${tUids - tIds}ms uids=${tFetch - tUids}ms candidates=${candidates.length} small=${smallSync}`
      );
    }

    const { maxUid, inserted } = await fetchProcessRange(
      client,
      candidates,
      existingUids,
      inboxFolder.id,
      lastUid,
      async (msg) => {
        await processMessage(msg, account, appFolders, existingMessageIds, {
          ...(bulkInitial || candidates.length > LIVE_LLM_MAX_CANDIDATES
            ? { skipLlmClassify: true }
            : {}),
          ...(smallSync ? { dedupeByDb: true } : {}),
        });
        return true;
      }
    );

    // Final counter refresh (best effort; last_uid is already persisted per
    // batch by fetchProcessRange).
    const folderUpdate: { last_uid: number; total_count?: number; unread_count?: number } = {
      last_uid: maxUid,
    };

    try {
      const status = await client.status("INBOX", {
        messages: true,
        unseen: true,
      });
      folderUpdate.total_count = status.messages || 0;
      folderUpdate.unread_count = status.unseen || 0;
    } catch (err) {
      console.warn("Could not fetch INBOX status (connection may have dropped):", err);
    }

    await updateFolder(inboxFolder.id, folderUpdate);

    return inserted;
  } finally {
    lock.release();
  }
}

/**
 * Categorise un message via LLM puis assigne les labels resolus. Best effort,
 * jamais bloquant : toute erreur est loggee et ignoree.
 */
export interface CategorizeAndApplyResult {
  labelIds: string[];
  /** Niveau final ecrit sur le message (null = inchange / inconnu). */
  importance: Importance | null;
}

export async function categorizeAndApply(
  messageId: string,
  userId: string,
  input: {
    subject: string;
    from: { name?: string; address: string };
    bodyText: string;
    threadId?: string;
    /** Signaux deja calcules a la sync (sender-trust). */
    sentToCount?: number;
    receivedInboxCount?: number;
    listUnsubscribe?: boolean;
    fromSelf?: boolean;
    /** Niveau pose a la creation (regle / repli) ; une correction "user" n'est jamais ecrasee. */
    currentImportance?: Importance | null;
    currentImportanceSource?: string;
  }
): Promise<string[]> {
  const r = await categorizeAndApplyFull(messageId, userId, input);
  return r.labelIds;
}

/**
 * Categorise (labels) ET classe (niveau d'importance) dans le MEME appel LLM,
 * puis ecrit les deux en une seule mise a jour du message.
 */
export async function categorizeAndApplyFull(
  messageId: string,
  userId: string,
  input: Parameters<typeof categorizeAndApply>[2]
): Promise<CategorizeAndApplyResult> {
  const t0 = Date.now();
  const fallbackImportance = input.currentImportance ?? null;
  try {
    const userKey = await getUserOpenRouterKey(userId);
    const envKey = process.env.OPENROUTER_API_KEY || "";
    const apiKey = userKey || envKey;
    const keySource = userKey ? "user" : envKey ? "env" : "none";
    if (!apiKey) {
      console.warn(
        `[categorize] FAIL ${messageId} : pas de cle OpenRouter (user=${userId})`
      );
      return { labelIds: [], importance: fallbackImportance };
    }
    const existing = await listLabelNames(userId);
    const ctx = await getImportanceContext(userId);
    const result = await categorizeMessageFull(
      {
        subject: input.subject,
        from: input.from,
        bodyText: input.bodyText,
        existingLabels: existing,
        signals: {
          sentToCount: input.sentToCount ?? 0,
          receivedInboxCount: input.receivedInboxCount ?? 0,
          listUnsubscribe: input.listUnsubscribe,
        },
        examples: ctx.examples,
      },
      { apiKey }
    );
    const dur = Date.now() - t0;

    // Niveau : regle > (deja ecrit a l'expediteur => jamais low) > IA > repli.
    // Une correction manuelle de CE mail (source "user") n'est jamais ecrasee.
    let importance: Importance | null = fallbackImportance;
    let importanceSource: string | undefined;
    if (input.currentImportanceSource !== "user") {
      const decided = decideImportance({
        rules: ctx.rules,
        fromAddress: input.from?.address,
        subject: input.subject,
        sentToCount: input.sentToCount ?? 0,
        listUnsubscribe: input.listUnsubscribe,
        fromSelf: input.fromSelf,
        ai: result?.importance ?? null,
      });
      importance = decided.importance;
      importanceSource = decided.source;
    }
    const importancePatch =
      importanceSource &&
      (importance !== input.currentImportance || importanceSource !== input.currentImportanceSource)
        ? {
            importance: (importance || "") as Importance | "",
            importance_source: importanceSource as "ai" | "rule" | "user" | "heuristic",
          }
        : null;

    const names = result?.categories || [];
    if (names.length === 0) {
      console.warn(
        `[categorize] EMPTY ${messageId} "${(input.subject || "").slice(0, 60)}" (key=${keySource}, ${dur}ms) -> LLM n'a retourne aucune categorie (niveau=${importance ?? "?"})`
      );
      if (importancePatch) await updateMessage(messageId, importancePatch).catch(() => {});
      return { labelIds: [], importance };
    }
    const ids = await resolveLabelIds(userId, names);

    // Appliquer les overrides explicites de l'utilisateur sur ce thread :
    // retirer les labels exclus, forcer les labels inclus. La decision de
    // l'utilisateur prime sur l'IA.
    let finalIds = ids;
    let overrideNote = "";
    if (input.threadId) {
      try {
        const { included, excluded } = await loadThreadLabelOverrides(userId, input.threadId);
        if (excluded.size > 0 || included.size > 0) {
          const filtered = ids.filter((id) => !excluded.has(id));
          const withIncluded = filtered.slice();
          for (const inc of included) {
            if (!withIncluded.includes(inc)) withIncluded.push(inc);
          }
          finalIds = withIncluded;
          overrideNote = ` [overrides: -${excluded.size}/+${included.size}]`;
        }
      } catch (err) {
        console.warn(`[categorize] override lookup failed for thread=${input.threadId}:`, err);
      }
    }

    if (finalIds.length === 0) {
      console.warn(`[categorize] NOLABEL ${messageId} : resolveLabelIds vide pour [${names.join(", ")}]${overrideNote}`);
      if (importancePatch) await updateMessage(messageId, importancePatch).catch(() => {});
      return { labelIds: [], importance };
    }
    await updateMessage(messageId, { labels: finalIds, ...(importancePatch || {}) });
    console.log(
      `[categorize] OK ${messageId} (key=${keySource}, ${dur}ms, ${result?.model}) -> ${names.join(", ")} | niveau=${importance ?? "?"}${importanceSource ? `/${importanceSource}` : ""}${overrideNote}`
    );
    return { labelIds: finalIds, importance };
  } catch (err) {
    console.warn(`[categorize] ERROR ${messageId} (${Date.now() - t0}ms):`, err);
    return { labelIds: [], importance: fallbackImportance };
  }
}

/**
 * Extrait une adresse exploitable des entetes bruts quand le parser n'a pas
 * resolu de From (Return-Path / Sender / From). Dernier filet avant le fallback
 * generique de la notification.
 */
function extractAddressFromHeaders(rawHeaders: string): string {
  if (!rawHeaders) return "";
  const patterns = [
    /^Return-Path:\s*(.+)$/im,
    /^Sender:\s*(.+)$/im,
    /^From:\s*(.+)$/im,
  ];
  for (const re of patterns) {
    const m = rawHeaders.match(re);
    if (m && m[1]) {
      const raw = m[1].trim();
      const angle = raw.match(/<([^>]+)>/);
      const addr = (angle ? angle[1] : raw).trim();
      if (addr && addr !== "<>") return addr;
    }
  }
  return "";
}

/**
 * Titre de la notification push : nom de l'expediteur si dispo, sinon adresse,
 * sinon adresse extraite des entetes bruts (Return-Path/Sender/From), sinon le
 * sujet du mail. Evite les notifications "Unknown" sur les expediteurs que le
 * parser n'a pas su decoder.
 */
export function resolveSenderLabel(parsed: ParsedEmail, rawHeaders: string): string {
  if (parsed.from?.name) return parsed.from.name;
  if (parsed.from?.address) return parsed.from.address;
  const fromHeaders = extractAddressFromHeaders(rawHeaders);
  if (fromHeaders) return fromHeaders;
  if (parsed.subject && parsed.subject !== "(no subject)") return parsed.subject;
  return "Nouveau message";
}

/**
 * Envoie la notification push d'un nouveau mail, mais SEULEMENT s'il restera
 * visible dans l'inbox : on saute les mails dont l'utilisateur a desactive les
 * notifications et ceux portant au moins un label secondaire (Newsletter,
 * Promotion, Notification... -> masques de l'inbox par exclude_secondary).
 * Le filtre folder (pas de spam) est applique par l'appelant.
 * `messageId` = id d'enregistrement PocketBase ; `messageIdHeader` = en-tete
 * Message-ID (anti double notification entre comptes, cf notify-dedup.ts).
 */
export async function maybeNotifyNewMail(
  userId: string,
  senderLabel: string,
  subject: string,
  accountId: string,
  messageId: string,
  labelIds: string[],
  threadId?: string,
  senderAddress?: string,
  messageIdHeader?: string,
  importance?: Importance | null
): Promise<void> {
  try {
    // Labels secondaires (Newsletter/Promo/Notif...) : masques de l'inbox ->
    // exclus AUSSI du journal d'activite et du push (le mail reste ailleurs).
    if (await hasAnySecondaryLabel(userId, labelIds)) return;
    // Meme mail deja arrive sur un AUTRE compte de l'utilisateur (destinataires
    // multiples, transfert, releve POP3 d'une boite par une autre) : la copie
    // la plus ancienne a deja notifie -> ni activite ni push pour celle-ci.
    if (await isLaterCopyOfMailOnOtherAccount(userId, messageId, messageIdHeader)) {
      console.log(`[notify] SKIP ${messageId} : copie d'un mail deja notifie sur un autre compte`);
      return;
    }
    // Journal d'activite : ECRIT MEME si le push est desactive (historique 30j,
    // decouple du push). Best effort, non bloquant.
    void logNewMailActivity({
      userId,
      accountId,
      senderLabel,
      subject,
      messageId,
      threadId,
      senderAddress,
    }).catch((err) =>
      console.warn("[activity] new mail log failed:", (err as Error).message)
    );
    // Push : uniquement si l'utilisateur l'a active.
    if (!(await getUserNotificationsEnabled(userId))) return;
    // Tri en trois niveaux : par defaut seuls les importants et les secondaires
    // sonnent (users.notify_importance) ; le journal d'activite garde tout.
    if (importance) {
      const { notify } = await getImportanceContext(userId);
      if (!importanceAllowsNotification(importance, notify)) {
        console.log(`[notify] SKIP ${messageId} : niveau ${importance} non notifie (reglage=${notify || "important_secondary"})`);
        return;
      }
    }
    await sendNewEmailNotification(userId, senderLabel, subject, accountId, messageId, threadId, senderAddress);
  } catch (err) {
    console.error("Error sending push notification:", err);
  }
}

/**
 * Process a single IMAP message and store in the appropriate app folder.
 * Messages go to inbox by default, spam folder if detected by Rspamd.
 */
async function processMessage(
  msg: FetchMessageObject,
  account: PBAccount,
  appFolders: Record<string, PBFolder>,
  existingMessageIds: Set<string>,
  opts: { skipLlmClassify?: boolean; dedupeByDb?: boolean } = {}
): Promise<void> {
  if (!msg.source) {
    console.warn(`Message UID ${msg.uid} has no source, skipping`);
    return;
  }

  // Extract raw headers from source before parsing
  const sourceStr = msg.source.toString("latin1");
  const headerEndIndex = sourceStr.indexOf("\r\n\r\n");
  const rawHeaders = (headerEndIndex > -1
    ? sourceStr.substring(0, headerEndIndex)
    : sourceStr.substring(0, Math.min(sourceStr.length, 5000))
  ).substring(0, 5000);

  const tParse = Date.now();
  const parsed = await parseEmail(msg.source);

  // Deduplicate by message_id
  if (parsed.messageId && existingMessageIds.has(parsed.messageId)) {
    return;
  }
  // Hot path live : le set n'est pas precharge, dedup par requete point.
  if (
    opts.dedupeByDb &&
    parsed.messageId &&
    (await messageIdExists(account.id, parsed.messageId))
  ) {
    existingMessageIds.add(parsed.messageId);
    return;
  }
  const tParsed = Date.now();

  // Mail retrouve longtemps apres sa date (rattrapage) : pas d'IA payante.
  if (
    !opts.skipLlmClassify &&
    parsed.date &&
    Date.now() - new Date(parsed.date).getTime() > LIVE_LLM_MAX_AGE_MS
  ) {
    opts = { ...opts, skipLlmClassify: true };
  }

  const threadId = calculateThreadId({
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references.join(" "),
  });

  const flags = msg.flags || new Set<string>();
  const isRead = flags.has("\\Seen");
  const isStarred = flags.has("\\Flagged");
  const isDraft = flags.has("\\Draft");

  // Expediteur bloque ? -> corbeille direct (style Gmail) : jamais en inbox,
  // pas de notification, pas de categorisation ni d'agregation Cerveau (toutes
  // ces etapes sont conditionnees a targetFolder.type === "inbox" plus bas).
  // On court-circuite avant le scan spam/LLM : inutile de payer pour un mail
  // qu'on jette. L'utilisateur peut le recuperer dans la corbeille en cas
  // d'erreur. Ne s'applique pas pendant la sync initiale en masse (le mail
  // existant ne doit pas etre rebascule), seulement aux vrais nouveaux mails.
  const blockedSenders =
    account.sync_status === "initial" ? [] : await getUserBlockedSenders(account.user);
  const senderAddr = (parsed.from?.address || "").toLowerCase().trim();
  const isBlockedSender = !!senderAddr && blockedSenders.includes(senderAddr);

  // Determine target folder: blocked -> trash, sinon spam check, sinon inbox
  let targetFolder = appFolders["inbox"];
  let spamScore = 0;
  let spamAction = "";

  if (isBlockedSender && appFolders["trash"]) {
    targetFolder = appFolders["trash"];
    console.log(`Blocked sender routed to trash (${senderAddr}): ${parsed.subject}`);
  }

  const tBlocked = Date.now();
  const spamResult = isBlockedSender ? null : await checkSpam(msg.source);
  const tSpam = Date.now();
  if (spamResult) {
    spamScore = spamResult.score;
    spamAction = spamResult.action;
  }

  // Decision spam : le classifieur LLM (permissif, biais inbox) est l'arbitre
  // principal ; Rspamd sert de fallback si LLM indisponible/desactive.
  // Garde anti-backfill : pas d'appel LLM pendant la synchro initiale en masse.
  const llmEnabled = process.env.LLM_CLASSIFIER_ENABLED !== "false";
  // Pas d'appel LLM pendant la synchro initiale en masse NI pendant le
  // backfill historique (sinon des dizaines de milliers d'appels LLM payants).
  // isBlockedSender : deja route corbeille, on saute toute la decision spam.
  const skipLlm =
    opts.skipLlmClassify || account.sync_status === "initial" || isBlockedSender;
  const rspamdSaysSpam = spamResult?.isSpam ?? false;
  const rspamdReject = spamResult?.action === "reject";

  // Whitelist comportementale : si l'utilisateur a deja correspondu avec
  // cet expediteur, on saute directement en inbox sauf signal Rspamd
  // critique (reject = phishing/malware avere).
  const trust = isBlockedSender
    ? { level: "unknown" as const, sentToCount: 0, receivedInboxCount: 0, knownDomain: false, contactMessageCount: 0 }
    : await getSenderTrust(account, parsed.from?.address);
  const tTrust = Date.now();
  let isSpam = rspamdSaysSpam;
  if (trust.level === "trusted" && !rspamdReject) {
    isSpam = false;
    console.log(
      `Trust bypass (sent=${trust.sentToCount}, contact=${trust.contactMessageCount}): ${parsed.subject}`
    );
  } else if (llmEnabled && !skipLlm) {
    const verdict = await classifyMessage({
      subject: parsed.subject,
      from: parsed.from,
      bodyText: parsed.textBody || parsed.snippet,
      rspamdScore: spamResult?.score,
      context: {
        sentToCount: trust.sentToCount,
        receivedInboxCount: trust.receivedInboxCount,
        knownDomain: trust.knownDomain,
        inContacts: trust.contactMessageCount > 0,
      },
    });
    if (verdict) {
      isSpam = verdict.spam;
      // Garde-fou : si "known" et LLM hesite, on penche inbox.
      if (verdict.spam && trust.level === "known" && !rspamdReject) {
        isSpam = false;
        console.log(
          `Trust override (known domain, rspamd ok): ${parsed.subject} -- LLM said spam: ${verdict.reason}`
        );
      } else {
        console.log(
          `LLM classify (spam=${verdict.spam}, rspamd=${spamScore}, trust=${trust.level}): ${parsed.subject} -- ${verdict.reason}`
        );
      }
    } else {
      console.log(
        `LLM classify unavailable, fallback Rspamd (spam=${rspamdSaysSpam}): ${parsed.subject}`
      );
    }
  }

  if (isSpam && appFolders["spam"]) {
    targetFolder = appFolders["spam"];
    console.log(
      `Spam routed (score=${spamScore}, action=${spamAction}): ${parsed.subject}`
    );
  }

  if (parsed.messageId) {
    existingMessageIds.add(parsed.messageId);
  }

  // Source newsletter designee ? (inbox, live uniquement). Un tel mail est
  // agrege dans le flux Newsletters : on le marque LU dans la boite (il vit
  // dans le flux) et on remplace la notif e-mail classique par une notif
  // "newsletter agregee" envoyee une fois la synthese prete.
  const tClassify = Date.now();
  // Resume du lundi (newsletter-digest.ts) depose par la messagerie elle-meme :
  // jamais agrege en newsletter, ni categorise, ni notifie (sa notification
  // courte part deja avec le depot).
  const isImielDigest = isDigestMessageId(parsed.messageId);
  const isNewsletterSource =
    !isImielDigest &&
    targetFolder.type === "inbox" &&
    !opts.skipLlmClassify &&
    account.sync_status !== "initial" &&
    (await isDesignatedSource(account.user, parsed.from?.address, parsed.from?.name));

  // Niveau d'importance pose DES la creation (regle expediteur ou repli sans
  // IA) : il est connu meme si la categorisation est sautee (backfill,
  // budget, erreur), et l'IA l'affine ensuite dans le meme appel que les labels.
  const listUnsubscribe = /^list-unsubscribe:/im.test(rawHeaders || "");
  const fromSelf =
    !!parsed.from?.address &&
    parsed.from.address.toLowerCase() === (account.email || "").toLowerCase();
  let initialImportance: { importance: Importance; source: string } | null = null;
  if (!isDraft && targetFolder.type !== "spam" && targetFolder.type !== "trash") {
    const impCtx = await getImportanceContext(account.user).catch(() => null);
    initialImportance = decideImportance({
      rules: impCtx?.rules || [],
      fromAddress: parsed.from?.address,
      subject: parsed.subject,
      sentToCount: trust.sentToCount,
      listUnsubscribe,
      fromSelf,
      ai: null,
    });
  }

  const tCreate = Date.now();
  const pbMessage = await createMessage({
    ...(initialImportance
      ? {
          importance: initialImportance.importance,
          importance_source: initialImportance.source as "rule" | "heuristic",
        }
      : {}),
    account: account.id,
    folder: targetFolder.id,
    message_id: parsed.messageId,
    thread_id: threadId,
    subject: parsed.subject,
    from_address: parsed.from,
    to_addresses: parsed.toAddresses,
    cc_addresses: parsed.ccAddresses,
    bcc_addresses: parsed.bccAddresses,
    date: parsed.date,
    snippet: parsed.snippet,
    text_body: parsed.textBody,
    html_body: parsed.htmlBody,
    is_read: isRead || isNewsletterSource,
    is_starred: isStarred,
    is_draft: isDraft,
    has_attachments: parsed.hasAttachments,
    uid: msg.uid,
    references: parsed.references,
    in_reply_to: parsed.inReplyTo,
    raw_headers: rawHeaders,
    spam_score: spamScore,
    spam_action: spamAction,
  });

  console.log(
    `[sync] msg uid=${msg.uid} timings: parse=${tParsed - tParse}ms blocked=${tBlocked - tParsed}ms spam=${tSpam - tBlocked}ms trust=${tTrust - tSpam}ms classify=${tClassify - tTrust}ms newsletter=${tCreate - tClassify}ms create=${Date.now() - tCreate}ms`
  );

  for (const att of parsed.attachments) {
    try {
      await createAttachment(pbMessage.id, {
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
        content: att.content,
        contentId: att.contentId,
        isInline: att.isInline,
      });
    } catch (err) {
      console.error(
        `Error uploading attachment ${att.filename} for message ${pbMessage.id}:`,
        err
      );
    }
  }

  // Import des invitations (.ics) dans l'Agenda (non bloquant)
  // Invitation (METHOD:REQUEST) : "a repondre" + notification "Nouvelle
  // invitation" seulement pour un mail recu en direct dans la boite.
  if (parsed.attachments.length > 0 && targetFolder.type !== "spam" && targetFolder.type !== "trash") {
    void importIcsFromEmail(account.user, parsed.attachments, {
      accountId: account.id,
      accountEmail: account.email,
      messageId: pbMessage.id,
      threadId,
      notify:
        !isDraft &&
        targetFolder.type === "inbox" &&
        !opts.skipLlmClassify &&
        account.sync_status !== "initial",
    }).catch((err) => {
      console.error("Error importing ICS from email:", err);
    });
  }

  // Indexation semantique incrementale (non bloquante)
  enqueueEmbedding(
    {
      id: pbMessage.id,
      account: account.id,
      subject: parsed.subject,
      text_body: parsed.textBody,
      html_body: parsed.htmlBody,
      from_address: parsed.from,
    },
    account.user
  );

  // Agregation Cerveau (memoire centrale) : UNIQUEMENT les vrais echanges
  // (filtre dossier reel + pas de label secondaire + expediteur trusted), pour
  // ne pas noyer la memoire dans le flux automatique. La sync initiale en masse
  // est couverte par le backfill. L'enqueue reel se fait dans la chaine de
  // categorisation ci-dessous (on a alors les labels -> detection secondaire).
  const cerveauMsgInput = {
    id: pbMessage.id,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.toAddresses,
    cc: parsed.ccAddresses,
    date: parsed.date,
    textBody: parsed.textBody,
    htmlBody: parsed.htmlBody,
    snippet: parsed.snippet,
    folderType: targetFolder.type,
    isSent: false,
    hasAttachments: parsed.hasAttachments,
  };
  const willAggregateCerveau =
    account.sync_status !== "initial" && !opts.skipLlmClassify;

  // Notification push : uniquement pour un VRAI nouveau mail visible dans
  // l'inbox (non lu, folder inbox, hors backfill historique et hors sync
  // initiale en masse). Le filtre "labels secondaires" est applique plus bas,
  // une fois la categorisation connue.
  const isLiveInboxMail =
    !isImielDigest &&
    !isRead &&
    !isNewsletterSource &&
    targetFolder.type === "inbox" &&
    !opts.skipLlmClassify &&
    account.sync_status !== "initial";
  const senderLabel = resolveSenderLabel(parsed, rawHeaders);

  // Suivi (cout minimal) : refresh si la conversation est deja suivie ; sinon
  // FILTRE VECTORIEL LOCAL (gratuit) pour rattacher a un suivi existant lie
  // (paiement, expedition, transporteur...). Gemini n'est appele que sur un
  // refresh ou un rattachement confirme par les vecteurs. Aucune detection auto.
  if (!isNewsletterSource && account.sync_status !== "initial" && !opts.skipLlmClassify) {
    void autoProcessMail(
      account.user,
      account.id,
      threadId,
      pbMessage.id,
      parsed.from?.address,
      { notify: true } // mail entrant LIVE -> autorise le push "changement de statut"
    ).catch((err) => console.error("[tracking] autoProcess error:", err));

  }

  // Categorisation IA (non bloquante) - seulement pour l'inbox, hors backfill
  const llmCategorizerEnabled = process.env.LLM_CATEGORIZER_ENABLED !== "false";
  const subjLog = (parsed.subject || "(sans sujet)").slice(0, 60);
  const willCategorize =
    !isImielDigest &&
    llmCategorizerEnabled &&
    !opts.skipLlmClassify &&
    account.sync_status !== "initial" &&
    targetFolder.type === "inbox";

  if (!llmCategorizerEnabled) {
    console.log(`[categorize] SKIP ${pbMessage.id} "${subjLog}" : LLM_CATEGORIZER_ENABLED=false`);
  } else if (opts.skipLlmClassify) {
    console.log(`[categorize] SKIP ${pbMessage.id} "${subjLog}" : skipLlmClassify=true (backfill historique)`);
  } else if (account.sync_status === "initial") {
    console.log(`[categorize] SKIP ${pbMessage.id} "${subjLog}" : sync_status=initial`);
  } else if (targetFolder.type !== "inbox") {
    console.log(`[categorize] SKIP ${pbMessage.id} "${subjLog}" : folder=${targetFolder.type} (pas inbox)`);
  }

  if (willCategorize) {
    console.log(`[categorize] START ${pbMessage.id} "${subjLog}" from=${parsed.from?.address}`);
    // La notification est chainee APRES la categorisation : on connait alors
    // les labels appliques et on saute le push si le mail porte un label
    // secondaire (Newsletter/Promotion/... -> masque de l'inbox). Non bloquant.
    void categorizeAndApplyFull(pbMessage.id, account.user, {
      subject: parsed.subject,
      from: parsed.from,
      bodyText: parsed.textBody || parsed.snippet,
      threadId: threadId,
      sentToCount: trust.sentToCount,
      receivedInboxCount: trust.receivedInboxCount,
      listUnsubscribe,
      fromSelf,
      currentImportance: initialImportance?.importance ?? null,
      currentImportanceSource: initialImportance?.source,
    })
      .then(({ labelIds, importance }) => {
        // Agregation Cerveau : on connait les labels -> filtre secondaire.
        if (willAggregateCerveau) {
          void aggregateMailIfReal(
            account,
            cerveauMsgInput,
            targetFolder.type,
            labelIds
          );
        }
        if (isLiveInboxMail) {
          return maybeNotifyNewMail(
            account.user,
            senderLabel,
            parsed.subject,
            account.id,
            pbMessage.id,
            labelIds,
            threadId,
            parsed.from?.address,
            parsed.messageId,
            importance
          );
        }
      })
      .catch((err) => console.error("[categorize] notify chain error:", err));
  } else {
    // Pas de categorisation pour ce mail : agreger quand meme (sans info de
    // label secondaire) si c'est un vrai echange.
    if (willAggregateCerveau) {
      void aggregateMailIfReal(account, cerveauMsgInput, targetFolder.type, []);
    }
  }

  if (!willCategorize && isLiveInboxMail) {
    // Pas de categorisation (desactivee) mais mail live inbox : aucun label
    // secondaire ne sera applique -> notifier tout de suite.
    void maybeNotifyNewMail(
      account.user,
      senderLabel,
      parsed.subject,
      account.id,
      pbMessage.id,
      [],
      threadId,
      parsed.from?.address,
      parsed.messageId,
      initialImportance?.importance ?? null
    );
  }

  // Flux Newsletters (non bloquant). Le mail est deja marque lu ci-dessus ;
  // processNewsletter enverra la notification "newsletter agregee" (notify:true)
  // une fois la synthese generee.
  if (isNewsletterSource) {
    void processNewsletter({
      messageId: pbMessage.id,
      userId: account.user,
      accountId: account.id,
      subject: parsed.subject,
      fromName: parsed.from?.name || "",
      fromAddress: parsed.from?.address || "",
      bodyText: parsed.textBody || parsed.snippet || "",
      htmlBody: parsed.htmlBody || "",
      threadId,
      messageDate: parsed.date,
      notify: true,
    });
  }
}

/**
 * Parse and store a single IMAP Sent message into the app "sent" folder.
 * Returns true if a new message was created, false if deduplicated.
 */
async function processSentMessage(
  msg: FetchMessageObject,
  account: PBAccount,
  sentFolder: PBFolder,
  existingMessageIds: Set<string>,
  opts: { dedupeByDb?: boolean } = {}
): Promise<boolean> {
  if (!msg.source) {
    console.warn(`Sent message UID ${msg.uid} has no source, skipping`);
    return false;
  }

  const parsed = await parseEmail(msg.source);

  // Deduplicate by message_id
  if (parsed.messageId && existingMessageIds.has(parsed.messageId)) {
    return false;
  }
  // Hot path live : le set n'est pas precharge, dedup par requete point.
  if (
    opts.dedupeByDb &&
    parsed.messageId &&
    (await messageIdExists(account.id, parsed.messageId))
  ) {
    existingMessageIds.add(parsed.messageId);
    return false;
  }

  const threadId = calculateThreadId({
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references.join(" "),
  });

  const flags = msg.flags || new Set<string>();

  if (parsed.messageId) {
    existingMessageIds.add(parsed.messageId);
  }

  // Extract raw headers
  const sourceStr = msg.source.toString("latin1");
  const headerEndIndex = sourceStr.indexOf("\r\n\r\n");
  const rawHeaders = (headerEndIndex > -1
    ? sourceStr.substring(0, headerEndIndex)
    : sourceStr.substring(0, Math.min(sourceStr.length, 5000))
  ).substring(0, 5000);

  const pbMessage = await createMessage({
    account: account.id,
    folder: sentFolder.id,
    message_id: parsed.messageId,
    thread_id: threadId,
    subject: parsed.subject,
    from_address: parsed.from,
    to_addresses: parsed.toAddresses,
    cc_addresses: parsed.ccAddresses,
    bcc_addresses: parsed.bccAddresses,
    date: parsed.date,
    snippet: parsed.snippet,
    text_body: parsed.textBody,
    html_body: parsed.htmlBody,
    is_read: flags.has("\\Seen"),
    is_starred: flags.has("\\Flagged"),
    is_draft: false,
    is_sent: true,
    has_attachments: parsed.hasAttachments,
    uid: msg.uid,
    references: parsed.references,
    in_reply_to: parsed.inReplyTo,
    raw_headers: rawHeaders,
  });

  enqueueEmbedding(
    {
      id: pbMessage.id,
      account: account.id,
      subject: parsed.subject,
      text_body: parsed.textBody,
      html_body: parsed.htmlBody,
      from_address: parsed.from,
    },
    account.user
  );

  // Agregation Cerveau (mail envoye = vrai echange) - non bloquant.
  // Historique couvert par le backfill.
  if (account.sync_status !== "initial") {
    void aggregateMailIfReal(
      account,
      {
        id: pbMessage.id,
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.toAddresses,
        cc: parsed.ccAddresses,
        date: parsed.date,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody,
        snippet: parsed.snippet,
        folderType: sentFolder.type,
        isSent: true,
        hasAttachments: parsed.hasAttachments,
      },
      sentFolder.type,
      []
    );
  }

  // Suivi : refresh d'un suivi si cette reponse envoyee appartient a son thread.
  if (account.sync_status !== "initial") {
    void autoProcessMail(
      account.user,
      account.id,
      threadId,
      pbMessage.id,
      parsed.from?.address
    ).catch((err) => console.error("[tracking] autoProcess (sent) error:", err));
  }

  for (const att of parsed.attachments) {
    try {
      await createAttachment(pbMessage.id, {
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
        content: att.content,
        contentId: att.contentId,
        isInline: att.isInline,
      });
    } catch (err) {
      console.error(
        `Error uploading attachment ${att.filename} for sent message ${pbMessage.id}:`,
        err
      );
    }
  }

  return true;
}

/**
 * Sync messages from the IMAP Sent folder into the app-native "sent" folder.
 * Discovers the actual IMAP Sent folder path via special-use attributes or name.
 */
async function syncSentFolder(
  client: ImapFlow,
  account: PBAccount,
  appFolders: Record<string, PBFolder>,
): Promise<number> {
  const sentFolder = appFolders["sent"];
  if (!sentFolder) return 0;

  // Discover the actual IMAP Sent folder path
  const mailboxes = await client.list();
  const sentMailbox = mailboxes.find(
    (m) =>
      m.specialUse === "\\Sent" ||
      ["sent", "sent mail", "sent items"].includes(m.name.toLowerCase())
  );

  if (!sentMailbox) {
    console.log("No Sent folder found on IMAP server, skipping sent sync");
    return 0;
  }

  // Update PB folder path to match IMAP path (e.g. "[Gmail]/Sent Mail")
  if (sentFolder.path !== sentMailbox.path) {
    await updateFolder(sentFolder.id, { path: sentMailbox.path });
  }

  const lock = await client.getMailboxLock(sentMailbox.path);
  try {
    const mailbox = client.mailbox as MailboxObject;
    if (!mailbox) return 0;

    const lastUid = sentFolder.last_uid || (await getLastUidForFolder(sentFolder.id));

    const uidNext = (mailbox as any).uidNext as number | undefined;
    if (lastUid > 0 && uidNext && lastUid >= uidNext - 1) {
      const status = await client.status(sentMailbox.path, {
        messages: true,
      });
      await updateFolder(sentFolder.id, {
        total_count: status.messages || 0,
        last_uid: lastUid,
      });
      return 0;
    }

    const { candidates, bulkInitial } = await resolveCandidateUids(client, lastUid, "Sent");
    const smallSync = !bulkInitial && candidates.length <= SMALL_SYNC_MAX;

    // Dedup against messages already in the sent folder (including those created by the send endpoint)
    const existingMessageIds = smallSync
      ? new Set<string>()
      : await listExistingMessageIds(account.id, sentFolder.id);
    const existingUids = smallSync
      ? await listExistingUidsAmong(sentFolder.id, candidates)
      : await listExistingUidsForFolder(sentFolder.id);

    const { maxUid, inserted } = await fetchProcessRange(
      client,
      candidates,
      existingUids,
      sentFolder.id,
      lastUid,
      (msg) =>
        processSentMessage(msg, account, sentFolder, existingMessageIds, {
          dedupeByDb: smallSync,
        })
    );

    const folderUpdate: { last_uid: number; total_count?: number } = {
      last_uid: maxUid,
    };

    try {
      const status = await client.status(sentMailbox.path, { messages: true });
      folderUpdate.total_count = status.messages || 0;
    } catch (err) {
      console.warn("Could not fetch Sent folder status:", err);
    }

    await updateFolder(sentFolder.id, folderUpdate);

    return inserted;
  } finally {
    lock.release();
  }
}

/**
 * Full IMAP sync for an account.
 * Creates app-native folders (inbox, sent, drafts, trash, spam) and
 * syncs messages from IMAP INBOX and Sent folder.
 */
export async function syncAccount(accountId: string): Promise<{
  folders: number;
  newMessages: number;
}> {
  const account = await getAccount(accountId);

  if (account.protocol !== "imap") {
    throw new Error(`Account ${accountId} is not an IMAP account`);
  }

  const config = await buildImapConfig(account);
  const client = new ImapFlow(config);

  try {
    await client.connect();
    console.log(`Connected to IMAP: ${account.imap_host} for ${account.email}`);

    // Ensure app-native folders exist (inbox, sent, drafts, trash, spam)
    const appFolders = await ensureAppFolders(accountId);
    console.log(`App folders ready (${Object.keys(appFolders).length})`);

    // Sync messages from IMAP INBOX
    let totalNewMessages = 0;
    const inboxNew = await syncInbox(client, account, appFolders);
    if (inboxNew > 0) {
      console.log(`INBOX: ${inboxNew} new message(s)`);
      totalNewMessages += inboxNew;
    }

    // Sync messages from IMAP Sent folder
    const sentNew = await syncSentFolder(client, account, appFolders);
    if (sentNew > 0) {
      console.log(`Sent: ${sentNew} new message(s)`);
      totalNewMessages += sentNew;
    }

    return { folders: Object.keys(appFolders).length, newMessages: totalNewMessages };
  } catch (err) {
    throw err;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Fetch raw email sources from IMAP by UIDs (batch).
 * Used for scanning existing messages with Rspamd.
 */
export async function fetchMessageSources(
  account: PBAccount,
  folderPath: string,
  uids: number[]
): Promise<Map<number, Buffer>> {
  if (uids.length === 0) return new Map();

  const config = await buildImapConfig(account);
  const client = new ImapFlow(config);
  const sources = new Map<number, Buffer>();

  try {
    await client.connect();
    const lock = await client.getMailboxLock(folderPath);
    try {
      const uidRange = uids.join(",");
      for await (const msg of client.fetch(uidRange, { uid: true, source: true }, { uid: true })) {
        if (msg.source) {
          sources.set(msg.uid, msg.source);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return sources;
}

/**
 * Test IMAP connection with given credentials.
 */
export async function testImapConnection(config: {
  host: string;
  port: number;
  email: string;
  password: string;
}): Promise<{ success: boolean; error?: string; folders?: string[] }> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    auth: {
      user: config.email,
      pass: config.password,
    },
    secure: config.port === 993,
    logger: false,
  });

  try {
    await client.connect();
    const mailboxes = await client.list();
    const folderNames = mailboxes.map((m) => m.path);
    await client.logout();

    return { success: true, folders: folderNames };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { success: false, error: formatImapError(raw) };
  }
}

function formatImapError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("invalid credentials") || lower.includes("authentication failed") || lower.includes("login failed") || lower.includes("authenticationfailed")) {
    return `Identifiants incorrects : nom d'utilisateur ou mot de passe invalide. (${message})`;
  }
  if (lower.includes("econnrefused")) {
    return `Connexion refusee : le serveur IMAP est injoignable. Verifiez l'hote et le port. (${message})`;
  }
  if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("timed out")) {
    return `Delai d'attente depasse : le serveur IMAP ne repond pas. Verifiez l'hote, le port et le type de securite. (${message})`;
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    return `Serveur introuvable : le nom d'hote IMAP est invalide ou le DNS ne resout pas. (${message})`;
  }
  if (lower.includes("self-signed") || lower.includes("certificate") || lower.includes("cert")) {
    return `Erreur de certificat SSL/TLS : le serveur utilise un certificat non reconnu. (${message})`;
  }
  if (lower.includes("wrong version") || lower.includes("ssl") || lower.includes("tls")) {
    return `Erreur SSL/TLS : verifiez que le port correspond au type de securite (993 pour SSL, 143 pour STARTTLS). (${message})`;
  }

  return `Erreur de connexion IMAP : ${message}`;
}

export interface HistoryProgress {
  total: number;
  done: number;
  inserted: number;
  phase: "preparing" | "inbox" | "sent" | "done";
}

/**
 * Taille de batch pour le fetch IMAP pendant le backfill historique.
 * Petit (25) car les sources brutes incluent les PJ : 25 messages tiennent en
 * memoire raisonnablement, et chaque batch tient en moins d'une minute sur le
 * reseau, ce qui evite les timeouts serveur (Gmail coupe les connexions IMAP
 * idle).
 */
const HISTORY_BATCH_SIZE = 25;
const HISTORY_MAX_RECONNECTS = 6;

function isImapConnectionError(err: unknown): boolean {
  const msg = (err as Error)?.message || "";
  return /connection not available|connection closed|socket|disconnected|timeout|ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH/i.test(
    msg
  );
}

async function fetchAllUids(
  client: ImapFlow,
  mailboxPath: string
): Promise<number[]> {
  const lock = await client.getMailboxLock(mailboxPath);
  try {
    const result = await client.search({ all: true }, { uid: true });
    return Array.isArray(result) ? (result as number[]) : [];
  } finally {
    lock.release();
  }
}

/**
 * Backfill une mailbox IMAP par batchs avec reconnexion automatique.
 *
 * Strategie :
 *  1. Lister tous les UIDs (rapide, sans `source`).
 *  2. Diff avec les UIDs deja en base -> liste des UIDs manquants.
 *  3. Boucler par batchs de HISTORY_BATCH_SIZE :
 *     - fetch des sources d'un batch (rapide, en memoire),
 *     - traitement hors stream IMAP (PB + Rspamd peuvent etre lents),
 *     - NOOP pour garder la connexion vivante.
 *  4. Sur erreur de connexion : reconnecter et reprendre au curseur courant.
 *
 * Le curseur (`cursor`) est conserve d'un essai a l'autre : meme apres un
 * "Connection not available", on continue exactement la ou on s'est arrete.
 */
async function backfillMailbox(
  account: PBAccount,
  mailboxPath: string,
  folderId: string,
  phase: "inbox" | "sent",
  processOne: (
    msg: FetchMessageObject,
    existingMessageIds: Set<string>
  ) => Promise<boolean>,
  state: { done: number; inserted: number; total: number },
  onProgress: (p: HistoryProgress) => void,
  shouldStop?: () => Promise<boolean>
): Promise<boolean> {
  const config = await buildImapConfig(account);
  const fetchOpts = {
    uid: true,
    flags: true,
    envelope: true,
    source: true,
    bodyStructure: true,
  } as const;

  // Estimation rapide pour eviter d'afficher "0 / N" pendant les longues
  // requetes ci-dessous (paginer 30k records prend du temps). Un seul
  // appel countRecords (perPage=1, totalItems) suffit.
  const estimatedPresent = await countRecords(
    "messages",
    `folder="${folderId}"`
  ).catch(() => 0);
  state.done += estimatedPresent;
  onProgress({ ...state, phase: "preparing" });

  const existingMessageIds = await listExistingMessageIds(
    account.id,
    folderId
  );
  const existingUids = await listExistingUidsForFolder(folderId);

  // Etape 1 : lister tous les UIDs (connexion courte)
  let allUids: number[] = [];
  {
    const client = new ImapFlow(config);
    try {
      await client.connect();
      allUids = await fetchAllUids(client, mailboxPath);
    } finally {
      await client.logout().catch(() => {});
    }
  }
  allUids.sort((a, b) => b - a); // recents d'abord

  // Etape 2 : diff (recale state.done sur la valeur exacte)
  const missing = allUids.filter((u) => !existingUids.has(u));
  const alreadyPresent = allUids.length - missing.length;
  state.done += alreadyPresent - estimatedPresent;
  onProgress({ ...state, phase });

  if (missing.length === 0) return false;

  // Etape 3 : traiter les UIDs manquants par batchs, avec reconnexion
  let cursor = 0;
  let reconnects = 0;
  let stopped = false;

  while (cursor < missing.length) {
    if (shouldStop && (await shouldStop())) {
      stopped = true;
      break;
    }
    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow(config);
      await client.connect();
      const lock = await client.getMailboxLock(mailboxPath);
      try {
        while (cursor < missing.length) {
          if (shouldStop && (await shouldStop())) {
            stopped = true;
            break;
          }
          const batch = missing.slice(cursor, cursor + HISTORY_BATCH_SIZE);

          // a) Telecharger les sources du batch en memoire (sans await lourd
          //    entre messages -> le stream IMAP n'est jamais idle)
          const messages: FetchMessageObject[] = [];
          for await (const msg of client.fetch(batch, fetchOpts, {
            uid: true,
          })) {
            messages.push(msg as FetchMessageObject);
          }

          // b) Traiter le batch hors stream IMAP
          for (const msg of messages) {
            try {
              const ins = await processOne(msg, existingMessageIds);
              existingUids.add(msg.uid);
              if (ins) state.inserted++;
            } catch (err) {
              console.error(
                `[history] ${phase} UID ${msg.uid} failed:`,
                err
              );
            }
            state.done++;
            if (state.done % 25 === 0) {
              onProgress({ ...state, phase });
            }
          }

          // Avancer le curseur du batch complet (les UIDs sans hit serveur
          // sont consideres comme "parcourus" pour eviter une boucle infinie)
          cursor += batch.length;
          reconnects = 0; // reset apres un batch reussi

          // c) Keepalive entre batchs
          await client.noop();
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      if (!isImapConnectionError(err)) throw err;
      reconnects++;
      if (reconnects > HISTORY_MAX_RECONNECTS) {
        throw new Error(
          `IMAP connection lost ${reconnects} times during ${phase} backfill (cursor ${cursor}/${missing.length}): ${(err as Error).message}`
        );
      }
      const delay = Math.min(30_000, 2_000 * 2 ** (reconnects - 1));
      console.warn(
        `[history] ${phase} connection lost at ${cursor}/${missing.length}, reconnect #${reconnects} in ${delay}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      if (client) await client.logout().catch(() => {});
    }
    if (stopped) break;
  }
  return stopped;
}

/**
 * Full mailbox history backfill for an IMAP account.
 *
 * The regular sync only imports the most recent INITIAL_SYNC_COUNT messages
 * per folder then advances last_uid, so old mail is never fetched. This walks
 * the ENTIRE UID space of INBOX and Sent, skipping UIDs already in
 * PocketBase. It does NOT touch folder.last_uid (incremental sync owns it):
 * it only fills the historical gap below it.
 *
 * Robustesse : traitement par petits batchs avec reconnexion automatique en
 * cas de "Connection not available" (Gmail coupe les connexions IMAP qui
 * restent ouvertes trop longtemps pendant les awaits de traitement).
 *
 * LLM spam classification is disabled here on purpose (skipLlmClassify) to
 * avoid tens of thousands of paid LLM calls; Rspamd (local) still runs.
 */
export async function historyBackfillAccount(
  accountId: string,
  onProgress: (p: HistoryProgress) => void,
  shouldStop?: () => Promise<boolean>
): Promise<boolean> {
  const account = await getAccount(accountId);
  if (account.protocol !== "imap") {
    throw new Error(`Account ${accountId} is not an IMAP account`);
  }

  const appFolders = await ensureAppFolders(accountId);

  // Pre-totaux : un seul connect rapide pour STATUS + LIST
  let inboxCount = 0;
  let sentCount = 0;
  let sentMailboxPath: string | null = null;
  {
    const config = await buildImapConfig(account);
    const client = new ImapFlow(config);
    try {
      await client.connect();
      const inboxStatus = await client.status("INBOX", { messages: true });
      inboxCount = inboxStatus.messages || 0;
      const mailboxes = await client.list();
      const sentMailbox =
        mailboxes.find(
          (m) =>
            m.specialUse === "\\Sent" ||
            ["sent", "sent mail", "sent items"].includes(
              m.name.toLowerCase()
            )
        ) || null;
      if (sentMailbox) {
        sentMailboxPath = sentMailbox.path;
        const st = await client.status(sentMailbox.path, { messages: true });
        sentCount = st.messages || 0;
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  const state = {
    done: 0,
    inserted: 0,
    total: inboxCount + sentCount,
  };
  onProgress({ ...state, phase: "inbox" });

  // INBOX history
  const inboxStopped = await backfillMailbox(
    account,
    "INBOX",
    appFolders["inbox"].id,
    "inbox",
    async (msg, existingMessageIds) => {
      await processMessage(msg, account, appFolders, existingMessageIds, {
        skipLlmClassify: true,
      });
      return true;
    },
    state,
    onProgress,
    shouldStop
  );
  if (inboxStopped) return true;

  // Sent history
  if (sentMailboxPath) {
    onProgress({ ...state, phase: "sent" });
    const sentFolder = appFolders["sent"];
    const sentStopped = await backfillMailbox(
      account,
      sentMailboxPath,
      sentFolder.id,
      "sent",
      (msg, existingMessageIds) =>
        processSentMessage(msg, account, sentFolder, existingMessageIds),
      state,
      onProgress,
      shouldStop
    );
    if (sentStopped) return true;
  }

  onProgress({ ...state, phase: "done" });
  return false;
}
