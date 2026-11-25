import net from "net";
import tls from "tls";
import { decrypt } from "./crypto";
import { parseEmail } from "./parser";
import { calculateThreadId } from "./threading";
import { maybeNotifyNewMail, resolveSenderLabel } from "./imap";
import { decideImportance } from "./importance";
import {
  type PBAccount,
  getAccount,
  updateAccount,
  upsertFolder,
  createMessage,
  createAttachment,
  findMessageByMessageId,
  getImportanceContext,
} from "./pocketbase";

/**
 * Minimal POP3 client implementation.
 * POP3 is simpler than IMAP: single mailbox, no folders, download-and-optionally-delete.
 */
class Pop3Client {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private responseResolve: ((value: string) => void) | null = null;
  private responseReject: ((reason: Error) => void) | null = null;
  private multiline = false;

  async connect(host: string, port: number, secure: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.socket!.on("data", (data: Buffer) => this.onData(data));
        // Wait for greeting
        this.responseResolve = resolve;
        this.responseReject = reject;
      };

      if (secure) {
        this.socket = tls.connect({ host, port, rejectUnauthorized: false }, onConnect);
      } else {
        this.socket = net.connect({ host, port }, onConnect);
      }

      this.socket.on("error", (err: Error) => {
        if (this.responseReject) {
          this.responseReject(err);
          this.responseResolve = null;
          this.responseReject = null;
        }
      });

      this.socket.setTimeout(30_000);
      this.socket.on("timeout", () => {
        const err = new Error("POP3 connection timeout");
        if (this.responseReject) {
          this.responseReject(err);
          this.responseResolve = null;
          this.responseReject = null;
        }
        this.socket?.destroy();
      });
    });
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString();

    if (this.multiline) {
      // Multiline response ends with \r\n.\r\n
      if (this.buffer.includes("\r\n.\r\n")) {
        const response = this.buffer;
        this.buffer = "";
        this.multiline = false;
        if (this.responseResolve) {
          this.responseResolve(response);
          this.responseResolve = null;
          this.responseReject = null;
        }
      }
      return;
    }

    // Single-line response ends with \r\n
    const idx = this.buffer.indexOf("\r\n");
    if (idx !== -1) {
      const response = this.buffer;
      this.buffer = "";
      if (this.responseResolve) {
        this.responseResolve(response);
        this.responseResolve = null;
        this.responseReject = null;
      }
    }
  }

  async command(cmd: string, multiline = false): Promise<string> {
    return new Promise((resolve, reject) => {
      this.multiline = multiline;
      this.responseResolve = resolve;
      this.responseReject = reject;
      this.socket!.write(cmd + "\r\n");
    });
  }

  async login(user: string, pass: string): Promise<void> {
    const userResp = await this.command(`USER ${user}`);
    if (!userResp.startsWith("+OK")) {
      throw new Error(`POP3 USER failed: ${userResp.trim()}`);
    }
    const passResp = await this.command(`PASS ${pass}`);
    if (!passResp.startsWith("+OK")) {
      throw new Error(`POP3 PASS failed: ${passResp.trim()}`);
    }
  }

  async stat(): Promise<{ count: number; size: number }> {
    const resp = await this.command("STAT");
    if (!resp.startsWith("+OK")) {
      throw new Error(`POP3 STAT failed: ${resp.trim()}`);
    }
    const parts = resp.trim().split(" ");
    return { count: parseInt(parts[1], 10), size: parseInt(parts[2], 10) };
  }

  async uidl(): Promise<{ num: number; uid: string }[]> {
    const resp = await this.command("UIDL", true);
    if (!resp.startsWith("+OK")) {
      throw new Error(`POP3 UIDL failed: ${resp.trim()}`);
    }

    const lines = resp.split("\r\n").slice(1); // Skip +OK line
    const result: { num: number; uid: string }[] = [];

    for (const line of lines) {
      if (line === "." || line === "") continue;
      const parts = line.trim().split(" ");
      if (parts.length >= 2) {
        result.push({ num: parseInt(parts[0], 10), uid: parts[1] });
      }
    }

    return result;
  }

  async retr(msgNum: number): Promise<string> {
    const resp = await this.command(`RETR ${msgNum}`, true);
    if (!resp.startsWith("+OK")) {
      throw new Error(`POP3 RETR failed: ${resp.trim()}`);
    }
    // Remove +OK line and trailing dot
    const firstLine = resp.indexOf("\r\n");
    let body = resp.substring(firstLine + 2);
    if (body.endsWith("\r\n.\r\n")) {
      body = body.substring(0, body.length - 5);
    }
    // Undo byte-stuffing (lines starting with ..)
    body = body.replace(/\r\n\.\./g, "\r\n.");
    return body;
  }

  async quit(): Promise<void> {
    try {
      await this.command("QUIT");
    } catch {
      // Ignore quit errors
    }
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Full POP3 sync for an account.
 * POP3 only has a single "inbox". We track seen UIDs via message_id in PocketBase.
 */
export async function syncPop3Account(accountId: string): Promise<{
  newMessages: number;
}> {
  const account = await getAccount(accountId);

  if (account.protocol !== "pop3") {
    throw new Error(`Account ${accountId} is not a POP3 account`);
  }

  const password = decrypt(account.imap_password);
  const client = new Pop3Client();
  const secure = account.imap_port === 995;

  try {
    await client.connect(account.imap_host, account.imap_port, secure);
    await client.login(account.imap_username || account.email, password);
    console.log(`Connected to POP3: ${account.imap_host} for ${account.email}`);

    // Ensure inbox folder exists
    const folder = await upsertFolder(accountId, {
      name: "INBOX",
      path: "INBOX",
      type: "inbox",
    });

    // Get message list with UIDs
    const messages = await client.uidl();
    let newMessageCount = 0;

    for (const msg of messages) {
      try {
        // Fetch the raw email
        const rawEmail = await client.retr(msg.num);
        const parsed = await parseEmail(rawEmail);

        // Check if already exists
        if (parsed.messageId) {
          const existing = await findMessageByMessageId(
            accountId,
            parsed.messageId
          );
          if (existing) continue;
        }

        // Calculate thread ID
        const threadId = calculateThreadId({
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references.join(" "),
        });

        // Niveau d'importance (repli sans IA : POP3 n'est pas categorise).
        const impCtx = await getImportanceContext(account.user).catch(() => null);
        const imp = decideImportance({
          rules: impCtx?.rules || [],
          fromAddress: parsed.from?.address,
          subject: parsed.subject,
          sentToCount: 0,
          listUnsubscribe: /^list-unsubscribe:/im.test(rawEmail.slice(0, 20000)),
          fromSelf: (parsed.from?.address || "").toLowerCase() === (account.email || "").toLowerCase(),
          ai: null,
        });

        // Store in PocketBase
        const pbMessage = await createMessage({
          importance: imp.importance,
          importance_source: imp.source as "rule" | "heuristic",
          account: accountId,
          folder: folder.id,
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
          is_read: false,
          is_starred: false,
          is_draft: false,
          has_attachments: parsed.hasAttachments,
          uid: msg.num,
          references: parsed.references,
          in_reply_to: parsed.inReplyTo,
        });

        // Upload attachments
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
              `Error uploading attachment ${att.filename}:`,
              err
            );
          }
        }

        // Push notification (respecte notifications_enabled ; POP3 = inbox
        // sans categorisation, donc pas de label secondaire a filtrer).
        await maybeNotifyNewMail(
          account.user,
          resolveSenderLabel(parsed, ""),
          parsed.subject,
          account.id,
          pbMessage.id,
          [],
          undefined,
          undefined,
          parsed.messageId,
          imp.importance
        );

        newMessageCount++;
      } catch (err) {
        console.error(
          `Error processing POP3 message #${msg.num}:`,
          err
        );
      }
    }

    // Update folder counts
    const stat = await client.stat();
    await upsertFolder(accountId, {
      name: "INBOX",
      path: "INBOX",
      type: "inbox",
      total_count: stat.count,
    });

    // Update last sync
    await updateAccount(accountId, {
      last_synced_at: new Date().toISOString(),
      sync_error: "",
    });

    return { newMessages: newMessageCount };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateAccount(accountId, { sync_error: errorMsg }).catch(() => {});
    throw err;
  } finally {
    await client.quit().catch(() => {});
  }
}
