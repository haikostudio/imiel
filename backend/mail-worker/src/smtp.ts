import { randomUUID } from "crypto";

import nodemailer, { type Transporter, type SendMailOptions } from "nodemailer";
import { ImapFlow } from "imapflow";

import { decrypt } from "./crypto";
import { getValidAccessToken } from "./oauth";
import { buildImapConfig } from "./imap";
import { injectTrackingPixel, uniqueRecipientEmails } from "./read-receipts";
import {
  type PBAccount,
  type PBMessage,
  type PBEmailAddress,
  type PBAttachment,
  getAccount,
  updateAccount,
  getMessage,
  getAttachmentsForMessage,
  getFileUrl,
} from "./pocketbase";

interface SendEmailParams {
  accountId: string;
  messageId: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth: {
    type?: string;
    user: string;
    pass?: string;
    accessToken?: string;
  };
}

// Delais courts pour la CONNEXION : sans eux nodemailer attend 2 min avant
// d'abandonner, le bouton d'envoi reste bloque et le repli 587 arrive trop tard.
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 60_000;

// Port de repli quand le port SSL direct (465) ne repond pas : le VPS bloque
// le 465 sortant (constate 2026-09-14, Infomaniak ET Gmail), le 587 STARTTLS passe.
const SMTP_FALLBACK_PORT = 587;

async function buildSmtpConfig(
  account: PBAccount,
  override?: { port: number }
): Promise<SmtpConfig> {
  const port = override?.port ?? account.smtp_port;
  const transportBase = {
    host: account.smtp_host,
    port,
    secure: port === 465,
    // En 587 on EXIGE STARTTLS : jamais d'identifiants envoyes en clair.
    requireTLS: port === SMTP_FALLBACK_PORT || account.smtp_security === "starttls" ? true : undefined,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  };

  if (account.auth_type === "oauth2") {
    const accessToken = await getValidAccessToken(account);
    return {
      ...transportBase,
      auth: {
        type: "OAUTH2",
        user: account.smtp_username || account.email,
        accessToken,
      },
    };
  }

  const password = decrypt(account.smtp_password);
  return {
    ...transportBase,
    auth: {
      user: account.smtp_username || account.email,
      pass: password,
    },
  };
}

/**
 * Echec de CONNEXION (le serveur n'a jamais repondu), par opposition a un refus
 * du serveur (identifiants, destinataire...). Seul ce cas justifie de changer de port.
 */
export function isSmtpConnectionError(err: unknown): boolean {
  const e = err as { code?: string; command?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code || "";
  if (["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ESOCKET"].includes(code)) {
    // ESOCKET couvre aussi des erreurs TLS apres connexion : ne garder que la phase CONN.
    return code !== "ESOCKET" || e.command === "CONN";
  }
  const msg = (e.message || "").toLowerCase();
  return msg.includes("connection timeout") || msg.includes("greeting never received");
}

function formatAddress(addr: PBEmailAddress): string {
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

function formatAddressList(addresses: PBEmailAddress[]): string[] | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  return addresses.map(formatAddress);
}

async function downloadAttachmentFile(
  attachment: PBAttachment
): Promise<Buffer> {
  const url = getFileUrl("attachments", attachment.id, attachment.file);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download attachment ${attachment.filename}: ${res.status}`
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Send an email using SMTP from a PocketBase message record.
 */
export async function sendEmail(params: SendEmailParams): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
}> {
  const { accountId, messageId } = params;

  const account = await getAccount(accountId);
  const message = await getMessage(messageId);
  const attachments = await getAttachmentsForMessage(messageId);

  let transport: Transporter = nodemailer.createTransport(
    (await buildSmtpConfig(account)) as any
  );
  // Nombre de copies deja ACCEPTEES par le serveur : le repli de port ne se
  // tente que si rien n'est parti (sinon un destinataire recevrait le mail 2x).
  let deliveredCount = 0;

  try {
    // Build attachment list
    const mailAttachments = await Promise.all(
      attachments.map(async (att) => {
        const content = await downloadAttachmentFile(att);
        return {
          filename: att.filename,
          content,
          contentType: att.content_type,
          cid: att.is_inline ? att.content_id : undefined,
        };
      })
    );

    // Build email - always use account.email as the authoritative sender
    const senderName = account.display_name || account.label || "";
    const senderAddress = account.email;
    const fromHeader = senderName
      ? `${senderName} <${senderAddress}>`
      : senderAddress;

    // Generate a stable Message-ID up front so the actual send, the IMAP Sent
    // copy (appendToImapSent) and the local PB record all share the SAME id.
    // Otherwise nodemailer mints a fresh Message-ID on each sendMail() call,
    // the appended copy gets a different id than the local record, IMAP sync
    // dedup (by message_id) fails, and the sent mail appears twice.
    const senderDomain = senderAddress.split("@")[1] || "localhost";
    const generatedMessageId = `<${randomUUID()}@${senderDomain}>`;

    // Suivi de lecture : pixel 1x1 injecte dans le HTML SORTANT uniquement.
    // La copie IMAP "Envoyes" (appendToImapSent) reste SANS pixel : sinon
    // relire son propre envoi depuis Gmail web / un autre client compterait
    // comme une lecture du destinataire.
    // Plusieurs destinataires : une copie SMTP par personne (To/Cc visibles
    // identiques, enveloppe a une seule adresse) pour nommer qui a ouvert.
    const originalHtml = linkInlineImages(message.html_body || "", attachments) || undefined;
    const envelopeRecipients = uniqueRecipientEmails(message);

    const mailOptions: SendMailOptions = {
      messageId: generatedMessageId,
      from: fromHeader,
      replyTo: fromHeader,
      sender: senderAddress,
      to: formatAddressList(message.to_addresses),
      cc: formatAddressList(message.cc_addresses),
      bcc: formatAddressList(message.bcc_addresses),
      subject: message.subject,
      text: message.text_body || undefined,
      inReplyTo: message.in_reply_to || undefined,
      references:
        message.references && message.references.length > 0
          ? message.references
          : undefined,
      attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
    };

    const deliver = async (): Promise<{ messageId?: string }> => {
      let info: { messageId?: string };
      if (originalHtml && envelopeRecipients.length > 0) {
        let lastInfo: { messageId?: string } = {};
        for (const recipient of envelopeRecipients) {
          lastInfo = await transport.sendMail({
            ...mailOptions,
            bcc: undefined,
            envelope: { from: senderAddress, to: recipient },
            html: injectTrackingPixel(originalHtml, messageId, recipient),
          });
          deliveredCount++;
        }
        info = lastInfo;
      } else {
        info = await transport.sendMail({
          ...mailOptions,
          envelope: {
            from: senderAddress,
            to: (message.to_addresses || []).map((a) => a.address).join(", "),
            cc:
              (message.cc_addresses || []).map((a) => a.address).join(", ") ||
              undefined,
            bcc:
              (message.bcc_addresses || []).map((a) => a.address).join(", ") ||
              undefined,
          },
          html: originalHtml,
        });
        deliveredCount++;
      }
      return info;
    };

    let info: { messageId?: string };
    try {
      info = await deliver();
    } catch (firstErr) {
      if (
        account.smtp_port !== 465 ||
        deliveredCount > 0 ||
        !isSmtpConnectionError(firstErr)
      ) {
        throw firstErr;
      }
      console.warn(
        `[smtp] ${account.email}: port 465 injoignable (${(firstErr as Error).message}), repli sur ${SMTP_FALLBACK_PORT} STARTTLS`
      );
      transport.close();
      transport = nodemailer.createTransport(
        (await buildSmtpConfig(account, { port: SMTP_FALLBACK_PORT })) as any
      );
      info = await deliver();
      // Retenir la voie qui marche : les envois suivants partent directement en 587.
      try {
        await updateAccount(account.id, {
          smtp_port: SMTP_FALLBACK_PORT,
          smtp_security: "starttls",
        });
        account.smtp_port = SMTP_FALLBACK_PORT;
        account.smtp_security = "starttls";
        console.log(`[smtp] ${account.email}: reglage SMTP enregistre en ${SMTP_FALLBACK_PORT} STARTTLS`);
      } catch (persistErr) {
        console.warn(`[smtp] ${account.email}: reglage 587 non enregistre:`, (persistErr as Error).message);
      }
    }

    const toSummary = (message.to_addresses || [])
      .map((a) => a.address)
      .join(", ");
    console.log(
      `Email sent: ${info.messageId} from ${account.email} to ${toSummary}`
    );

    // Append to IMAP Sent folder (best effort, don't block the response).
    // Copie SANS pixel de tracking (cf. commentaire ci-dessus).
    appendToImapSent(account, { ...mailOptions, html: originalHtml }).catch((err) => {
      console.error("Failed to append to IMAP Sent folder:", err);
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(`Failed to send email from ${account.email}:`, raw);
    // Phrase lisible pour la fenetre de redaction (affichee telle quelle en toast).
    const partial =
      deliveredCount > 0
        ? ` Attention : ${deliveredCount} copie(s) sont deja parties avant l'erreur.`
        : "";
    return {
      success: false,
      error: `Envoi impossible depuis ${account.email}. ${formatSmtpError(raw)}${partial} Le brouillon est conserve.`,
    };
  } finally {
    transport.close();
  }
}

/**
 * Test SMTP connection with given credentials.
 */
export async function testSmtpConnection(config: {
  host: string;
  port: number;
  email: string;
  password: string;
}): Promise<{ success: boolean; error?: string }> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    auth: {
      user: config.email,
      pass: config.password,
    },
  });

  try {
    await transport.verify();
    return { success: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { success: false, error: formatSmtpError(raw) };
  } finally {
    transport.close();
  }
}

/**
 * Append a sent message to the IMAP Sent folder (best effort).
 */
async function appendToImapSent(
  account: PBAccount,
  mailOptions: SendMailOptions
): Promise<void> {
  // Build raw RFC 5322 message using a stream transport
  const streamTransport = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
  });
  const rawInfo: any = await streamTransport.sendMail(mailOptions);

  const rawMessage = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    rawInfo.message.on("data", (chunk: any) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    rawInfo.message.on("end", () => resolve(Buffer.concat(chunks)));
    rawInfo.message.on("error", reject);
  });

  // Connect to IMAP
  const imapConfig = await buildImapConfig(account);
  const client = new ImapFlow(imapConfig);

  try {
    await client.connect();

    // Find Sent folder via special-use attributes or name
    const mailboxes = await client.list();
    const sentMailbox = mailboxes.find(
      (m) =>
        m.specialUse === "\\Sent" ||
        ["sent", "sent mail", "sent items"].includes(m.name.toLowerCase())
    );

    if (sentMailbox) {
      await client.append(sentMailbox.path, rawMessage, ["\\Seen"]);
      console.log(`Appended sent message to IMAP ${sentMailbox.path}`);
    } else {
      console.warn("No Sent folder found on IMAP server");
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function formatSmtpError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("invalid login") || lower.includes("authentication") || lower.includes("auth failed") || lower.includes("535")) {
    return `Identifiants incorrects : nom d'utilisateur ou mot de passe SMTP invalide. (${message})`;
  }
  if (lower.includes("econnrefused")) {
    return `Connexion refusee : le serveur SMTP est injoignable. Verifiez l'hote et le port. (${message})`;
  }
  if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("timed out")) {
    return `Delai d'attente depasse : le serveur SMTP ne repond pas. Verifiez l'hote, le port et le type de securite. (${message})`;
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    return `Serveur introuvable : le nom d'hote SMTP est invalide ou le DNS ne resout pas. (${message})`;
  }
  if (lower.includes("self-signed") || lower.includes("certificate") || lower.includes("cert")) {
    return `Erreur de certificat SSL/TLS : le serveur utilise un certificat non reconnu. (${message})`;
  }
  if (lower.includes("wrong version") || lower.includes("ssl") || lower.includes("tls")) {
    return `Erreur SSL/TLS : verifiez que le port correspond au type de securite (465 pour SSL, 587 pour STARTTLS). (${message})`;
  }

  return `Erreur de connexion SMTP : ${message}`;
}

/**
 * Images placees dans le texte par l'editeur : leur src pointe sur le fichier
 * PocketBase (/api/files/<collection>/<attachmentId>/<fichier>). Chez le
 * destinataire, ce lien serait casse : on le remplace par cid:<content_id>,
 * que nodemailer relie a la piece jointe du meme Content-ID.
 */
export function linkInlineImages(
  html: string,
  attachments: { id: string; content_id: string; is_inline: boolean }[],
): string {
  if (!html) return html;
  let out = html;
  for (const att of attachments) {
    if (!att.is_inline || !att.content_id) continue;
    const id = att.id.replace(/[^a-zA-Z0-9]/g, "");
    if (!id) continue;
    const re = new RegExp(`(<img\\b[^>]*?\\ssrc\\s*=\\s*)(["'])[^"']*/api/files/[^"'/]+/${id}/[^"']*\\2`, "gi");
    out = out.replace(re, (_m, pre: string, q: string) => `${pre}${q}cid:${att.content_id}${q}`);
  }
  return out;
}

/**
 * Reponse a une invitation (iMIP, METHOD:REPLY) envoyee depuis la boite qui l'a
 * recue. `from` = l'adresse invitee EXACTE (Outlook ignore une reponse d'une
 * autre adresse) ; l'enveloppe part du compte authentifie.
 */
export async function sendCalendarReply(
  account: PBAccount,
  mail: { from: string; fromName?: string; to: string; subject: string; text: string; ics: string }
): Promise<void> {
  const transport: Transporter = nodemailer.createTransport((await buildSmtpConfig(account)) as any);
  try {
    await transport.sendMail({
      from: mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      envelope: { from: account.email, to: mail.to },
      icalEvent: { method: "REPLY", content: mail.ics },
    });
  } finally {
    transport.close();
  }
}
