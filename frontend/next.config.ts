import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

// Turbopack root force sur le dossier frontend : evite que Next infere un
// mauvais workspace root a cause des lockfiles parents (HMR + resolution CSS).
const frontendRoot = dirname(fileURLToPath(import.meta.url));

const pbUrl = process.env.POCKETBASE_INTERNAL_URL || "http://127.0.0.1:8090";
const workerUrl = process.env.WORKER_INTERNAL_URL || "http://127.0.0.1:4001";

// Version du build : git short hash + timestamp ISO court (YYYYMMDD-HHmm).
// Sert a verifier visuellement quel build est servi (cache navigateur, SW,
// deploiement Docker non pris en compte). Affichee en bas de la sidebar
// settings. Override possible via env BUILD_HASH/BUILD_TIME en CI.
function getGitShortHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: frontendRoot,
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

const buildHash = process.env.BUILD_HASH || getGitShortHash();
const buildTime =
  process.env.BUILD_TIME ||
  new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-");
const BUILD_VERSION = `${buildHash}-${buildTime}`;

// En-tetes de securite poses sur toutes les pages.
// CSP : scripts/styles inline autorises (Next et le script de demarrage de
// layout.tsx en ont besoin) ; tout le reste est limite aux sources utilisees.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https:",
  // http://127.0.0.1 : serveur iMiel Cloud local (essais, auto-hebergement sur la machine).
  "connect-src 'self' https: wss: ws: http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "frame-src 'self' about: blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    root: frontendRoot,
  },
  env: {
    NEXT_PUBLIC_BUILD_VERSION: BUILD_VERSION,
  },
  rewrites: async () => [
    {
      source: "/api/:path*",
      destination: `${pbUrl}/api/:path*`,
    },
    {
      source: "/_/:path*",
      destination: `${pbUrl}/_/:path*`,
    },
    {
      source: "/worker/:path*",
      destination: `${workerUrl}/:path*`,
    },
  ],
  headers: async () => [
    { source: "/:path*", headers: SECURITY_HEADERS },
    {
      source: "/sw.js",
      headers: [
        {
          key: "Cache-Control",
          value: "no-cache, no-store, must-revalidate",
        },
        {
          key: "Service-Worker-Allowed",
          value: "/",
        },
      ],
    },
    {
      source: "/manifest.json",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=3600",
        },
      ],
    },
    {
      // HTML d'entree : toujours revalider pour qu'un rechargement (manuel ou
      // declenche par VersionWatcher) recupere immediatement les chunks du
      // dernier build. Sans ca, le webview desktop / le cache HTTP peut servir
      // un HTML perime qui reference d'anciens chunks (= "aucun changement"
      // apres deploiement). Les assets /_next/static restent immutables (hash).
      source: "/",
      headers: [
        {
          key: "Cache-Control",
          value: "no-store, must-revalidate",
        },
      ],
    },
  ],
};

// Interface STATIQUE embarquee dans l'app iPhone (copie complete) : servie par
// la base locale a la meme adresse (mobile/base/pbmobile). Ni serveur Next, ni
// redirections, ni en-tetes : construite par mobile/scripts/construire-interface-locale.mjs.
if (process.env.IMIEL_EXPORT === "1") {
  nextConfig.output = "export";
  delete nextConfig.rewrites;
  delete nextConfig.headers;
  nextConfig.images = { unoptimized: true };
}

export default nextConfig;
