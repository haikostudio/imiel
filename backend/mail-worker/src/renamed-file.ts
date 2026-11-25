/**
 * Fichiers d'etat et de cache renommes au passage HaikoMail -> iMiel
 * (`haikomail-*.db|json` -> `imiel-*`). Au premier demarrage sous le nouveau
 * nom, l'ancien fichier (et ses compagnons SQLite -wal / -shm) est RENOMME en
 * place : cache de vecteurs, index de recherche, budget IA du jour et reprise
 * du tri ne repartent pas de zero. Sans ancien fichier : rien a faire.
 */
import fs from "node:fs";
import path from "node:path";

export function legacyRenamed(newPath: string): string {
  const base = path.basename(newPath);
  if (!base.startsWith("imiel-")) return newPath;
  const oldPath = path.join(path.dirname(newPath), base.replace(/^imiel-/, "haikomail-"));
  try {
    if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(oldPath + suffix)) fs.renameSync(oldPath + suffix, newPath + suffix);
      }
      console.log(`[renommage] ${oldPath} -> ${newPath}`);
    }
  } catch (err) {
    // Dossier en lecture seule : on garde l'ancien fichier plutot que de repartir de zero.
    console.warn(`[renommage] ${oldPath} garde:`, (err as Error).message);
    if (fs.existsSync(oldPath)) return oldPath;
  }
  return newPath;
}
