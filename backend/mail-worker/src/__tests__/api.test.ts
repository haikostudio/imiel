import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { getAllSyncStates } from "../scheduler";

// Mock des modules externes
vi.mock("../imap", () => ({
  syncAccount: vi.fn().mockResolvedValue({ folders: 5, newMessages: 3 }),
  testImapConnection: vi.fn().mockResolvedValue({ success: true, folders: ["INBOX", "Sent"] }),
}));

vi.mock("../pop3", () => ({
  syncPop3Account: vi.fn().mockResolvedValue({ newMessages: 2 }),
}));

vi.mock("../smtp", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "<sent@test.com>" }),
  testSmtpConnection: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../push", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
}));

vi.mock("../pocketbase", () => ({
  getAccount: vi.fn().mockResolvedValue({
    id: "acc1",
    protocol: "imap",
    email: "test@example.com",
  }),
  listAccountsDueForSync: vi.fn().mockResolvedValue([]),
}));

// Recreer l'app Express pour les tests (sans le listen)
function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const activeSyncs = new Set<string>();

  app.post("/sync/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
    const accountId = req.params.accountId;
    if (activeSyncs.has(accountId)) {
      res.status(409).json({ error: "Sync already in progress for this account" });
      return;
    }
    activeSyncs.add(accountId);
    try {
      const { getAccount } = await import("../pocketbase");
      const account = await getAccount(accountId);
      let result: { folders?: number; newMessages: number };
      if (account.protocol === "pop3") {
        const { syncPop3Account } = await import("../pop3");
        result = await syncPop3Account(accountId);
      } else {
        const { syncAccount } = await import("../imap");
        result = await syncAccount(accountId);
      }
      res.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    } finally {
      activeSyncs.delete(accountId);
    }
  });

  app.post("/send", async (req: Request, res: Response) => {
    const { accountId, messageId } = req.body;
    if (!accountId || !messageId) {
      res.status(400).json({ error: "accountId and messageId are required" });
      return;
    }
    try {
      const { sendEmail } = await import("../smtp");
      const result = await sendEmail({ accountId, messageId });
      if (result.success) {
        res.json(result);
      } else {
        res.status(500).json(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post("/test-connection", async (req: Request, res: Response) => {
    const { type, host, port, email, password } = req.body;
    if (!type || !host || !port || !email || !password) {
      res.status(400).json({
        error: "type, host, port, email, and password are required",
      });
      return;
    }
    try {
      if (type === "imap") {
        const { testImapConnection } = await import("../imap");
        const result = await testImapConnection({ host, port, email, password });
        res.status(result.success ? 200 : 400).json(result);
      } else if (type === "smtp") {
        const { testSmtpConnection } = await import("../smtp");
        const result = await testSmtpConnection({ host, port, email, password });
        res.status(result.success ? 200 : 400).json(result);
      } else {
        res.status(400).json({ error: 'type must be "imap" or "smtp"' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post("/push", async (req: Request, res: Response) => {
    const { userId, title, body } = req.body;
    if (!userId || !title || !body) {
      res.status(400).json({ error: "userId, title, and body are required" });
      return;
    }
    try {
      const { sendPushToUser } = await import("../push");
      const result = await sendPushToUser(userId, req.body);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      activeSyncs: 0,
      syncStates: getAllSyncStates(),
      timestamp: new Date().toISOString(),
    });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

describe("API Routes", () => {
  const app = createApp();

  describe("GET /health", () => {
    it("retourne status ok", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("timestamp");
    });
  });

  describe("POST /sync/:accountId", () => {
    it("synchronise un compte IMAP", async () => {
      const res = await request(app).post("/sync/acc1");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.newMessages).toBe(3);
    });

    it("synchronise un compte POP3", async () => {
      const { getAccount } = await import("../pocketbase");
      vi.mocked(getAccount).mockResolvedValueOnce({
        id: "pop3-acc",
        protocol: "pop3",
        email: "test@example.com",
      } as any);

      const res = await request(app).post("/sync/pop3-acc");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("retourne 500 en cas d'erreur de sync", async () => {
      const { syncAccount } = await import("../imap");
      vi.mocked(syncAccount).mockRejectedValueOnce(new Error("Connection refused"));

      const res = await request(app).post("/sync/fail-acc");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Connection refused");
    });
  });

  describe("POST /send", () => {
    it("envoie un email", async () => {
      const res = await request(app)
        .post("/send")
        .send({ accountId: "acc1", messageId: "msg1" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("retourne 400 sans accountId", async () => {
      const res = await request(app)
        .post("/send")
        .send({ messageId: "msg1" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });

    it("retourne 400 sans messageId", async () => {
      const res = await request(app)
        .post("/send")
        .send({ accountId: "acc1" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /test-connection", () => {
    it("teste une connexion IMAP", async () => {
      const res = await request(app).post("/test-connection").send({
        type: "imap",
        host: "imap.test.com",
        port: 993,
        email: "test@test.com",
        password: "pass",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("teste une connexion SMTP", async () => {
      const res = await request(app).post("/test-connection").send({
        type: "smtp",
        host: "smtp.test.com",
        port: 587,
        email: "test@test.com",
        password: "pass",
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("retourne 400 pour un type invalide", async () => {
      const res = await request(app).post("/test-connection").send({
        type: "pop3",
        host: "host",
        port: 110,
        email: "test@test.com",
        password: "pass",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("imap");
    });

    it("retourne 400 si des champs manquent", async () => {
      const res = await request(app).post("/test-connection").send({
        type: "imap",
        host: "host",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });
  });

  describe("POST /push", () => {
    it("envoie une notification push", async () => {
      const res = await request(app).post("/push").send({
        userId: "user1",
        title: "Nouveau message",
        body: "Vous avez recu un email",
      });
      expect(res.status).toBe(200);
    });

    it("retourne 400 sans champs requis", async () => {
      const res = await request(app).post("/push").send({
        userId: "user1",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });
  });
});
