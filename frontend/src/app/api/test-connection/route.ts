import { NextRequest, NextResponse } from "next/server";

const MAIL_WORKER_URL =
  process.env.MAIL_WORKER_URL || "http://localhost:4001";

const PB_URL = process.env.POCKETBASE_INTERNAL_URL || "http://127.0.0.1:8090";

// Route PRIVEE : elle ouvre une connexion vers un serveur mail arbitraire ;
// on exige une session PocketBase valide (jeton dans l'en-tete Authorization).
async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  try {
    const r = await fetch(`${PB_URL}/api/collections/users/auth-refresh`, {
      method: "POST",
      headers: { Authorization: token },
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "session invalide" }, { status: 401 });
  }
  try {
    const body = await request.json();
    const res = await fetch(`${MAIL_WORKER_URL}/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Impossible de contacter le mail-worker" },
      { status: 502 }
    );
  }
}
