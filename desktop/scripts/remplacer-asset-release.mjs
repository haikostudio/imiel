// Remplace, dans une Release GitHub, l'asset qui porte le nom du fichier donne
// (ex. le .dmg depose par tauri-action) par ce fichier (l'image notarisee).
// Usage : node remplacer-asset-release.mjs <proprietaire/depot> <tag> <fichier>
// Jeton : GITHUB_TOKEN. Sans dependance (fetch de Node >= 18).
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [repo, tag, fichier] = process.argv.slice(2);
const jeton = process.env.GITHUB_TOKEN;
if (!repo || !tag || !fichier || !jeton) {
  console.error("usage : GITHUB_TOKEN=... node remplacer-asset-release.mjs <depot> <tag> <fichier>");
  process.exit(2);
}
const nom = basename(fichier);
const entetes = {
  Authorization: `Bearer ${jeton}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "imiel-desktop-release",
};

async function api(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...entetes, ...(init.headers || {}) } });
  if (!r.ok && r.status !== 204) throw new Error(`${init.method || "GET"} ${url} -> ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const rel = await api(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
for (const a of rel.assets.filter((x) => x.name === nom)) {
  await api(`https://api.github.com/repos/${repo}/releases/assets/${a.id}`, { method: "DELETE" });
  console.log(`ancien asset retire : ${a.name} (${a.id})`);
}
const corps = readFileSync(fichier);
const neuf = await api(
  `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(nom)}`,
  { method: "POST", body: corps, headers: { "Content-Type": "application/octet-stream" } },
);
console.log(`asset televerse : ${neuf.name} (${neuf.size} octets) dans ${tag}`);
