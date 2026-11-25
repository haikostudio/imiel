import { NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Dictee du chat IA : son -> texte, en LOCAL sur le VPS (faster-whisper, rien
 * ne part chez un tiers ; OpenRouter ne fait pas de transcription).
 *
 * Le moteur vit HORS depot : /var/lib/imiel/whisper (venv + modeles +
 * transcribe.py), pose par `sudo bash deploy/transcription/install.sh`.
 * Chemins surchargeables par IMIEL_WHISPER_PYTHON / IMIEL_WHISPER_SCRIPT (les
 * anciens noms HAIKOMAIL_* restent lus ; l'ancien dossier /var/lib/haikomail
 * est repris tant que le nouveau n'existe pas).
 */
export const runtime = "nodejs";

const env = (name: string): string | undefined => process.env[`IMIEL_${name}`] || process.env[`HAIKOMAIL_${name}`];
const WHISPER_HOME =
  env("WHISPER_HOME") ||
  (existsSync("/var/lib/imiel/whisper") || !existsSync("/var/lib/haikomail/whisper")
    ? "/var/lib/imiel/whisper"
    : "/var/lib/haikomail/whisper");
const PYTHON = env("WHISPER_PYTHON") || path.join(WHISPER_HOME, "venv/bin/python");
const SCRIPT = env("WHISPER_SCRIPT") || path.join(WHISPER_HOME, "transcribe.py");
const PB_URL = process.env.POCKETBASE_INTERNAL_URL || "http://127.0.0.1:8090";
// ~10 min de parole en opus : au-dela c'est une erreur, pas une dictee.
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const LANGS = new Set(["fr", "en", "de", "it"]);

function extFor(type: string): string {
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg")) return "mp3";
  return "webm";
}

// Transcrire coute du CPU : on exige une session PocketBase valide.
async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
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

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "session invalide" }, { status: 401 });
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) return Response.json({ error: "enregistrement vide" }, { status: 400 });
  if (buf.length > MAX_BYTES) return Response.json({ error: "enregistrement trop long" }, { status: 413 });

  try {
    await fs.access(PYTHON);
    await fs.access(SCRIPT);
  } catch {
    return Response.json({ error: "moteur de transcription absent du serveur" }, { status: 503 });
  }

  const lang = req.nextUrl.searchParams.get("lang") || "fr";
  const file = path.join(
    os.tmpdir(),
    `imiel-dictee-${crypto.randomUUID()}.${extFor(req.headers.get("content-type") || "")}`
  );
  await fs.writeFile(file, buf);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        PYTHON,
        [SCRIPT, file, LANGS.has(lang) ? lang : "fr"],
        { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, IMIEL_WHISPER_DIR: path.join(WHISPER_HOME, "models"), HAIKOMAIL_WHISPER_DIR: path.join(WHISPER_HOME, "models") } },
        (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).toString().trim().split("\n").pop() || "echec"));
          else resolve(stdout.toString().trim());
        }
      );
    });
    return Response.json({ text });
  } catch (err) {
    console.error("[transcribe]", (err as Error).message);
    return Response.json({ error: (err as Error).message.slice(0, 200) }, { status: 500 });
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}
