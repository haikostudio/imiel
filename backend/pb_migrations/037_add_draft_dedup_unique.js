/// <reference path="../pb_data/types.d.ts" />

// Anti-doublon BROUILLONS, garanti au niveau base.
//
// PROBLEME : a l'ouverture d'une reponse, plusieurs sauvegardes auto (instances
// d'editeur, remounts, fenetres) partent quasi simultanement SANS draft_id. La
// dedup applicative de auto-save.pb.js (verifier-puis-creer) souffre d'une
// course : 4 POST concurrents lisent tous "aucun brouillon" avant qu'aucun
// n'ait commit -> 4 brouillons identiques (meme compte/thread/sujet/dest).
//
// SOLUTION : un index UNIQUE PARTIEL sur (account, thread_id, subject,
// to_addresses) pour is_draft=1. La base rend la garantie atomique : un insert
// gagne, les concurrents perdants prennent une violation de contrainte, geree
// dans le hook (reutilisation du gagnant).
//
// Partiel : seulement les brouillons "significatifs" (sujet OU destinataire non
// vide). Les brouillons totalement vierges (nouveau message non rempli) ne sont
// PAS contraints -> on peut en avoir plusieurs ouverts.
//
// PREREQUIS : nettoyer les doublons existants AVANT de creer l'index unique.

// Condition partielle : seulement les brouillons avec un SUJET non vide. C'est
// le cas de tous les doublons observes (reponses "Re: ...") et ca laisse libres
// les brouillons "nouveau message" encore vierges (sujet vide -> non contraints,
// on peut en ouvrir plusieurs). WHERE volontairement simple : le parser d'index
// de PocketBase rejette COALESCE / NOT IN (cf migration 026 `uid > 0`).
const DRAFT_MEANINGFUL = "is_draft = 1 AND subject != ''";

const DEDUP_INDEX =
  "CREATE UNIQUE INDEX `idx_msg_draft_dedup` ON `messages` " +
  "(`account`, `thread_id`, `subject`, `to_addresses`) WHERE " +
  DRAFT_MEANINGFUL;

migrate(
  (app) => {
    const db = app.db();

    // 1) Nettoyer les doublons existants : ne garder, par groupe
    //    (account, thread_id, subject, to_addresses), que la ligne au plus grand
    //    rowid (la plus recemment inseree). Raw SQL pour grouper EXACTEMENT sur
    //    les memes colonnes brutes que l'index unique -> 0 doublon residuel.
    db.newQuery(
      "DELETE FROM messages WHERE " + DRAFT_MEANINGFUL + " AND rowid NOT IN (" +
        "SELECT MAX(rowid) FROM messages WHERE " + DRAFT_MEANINGFUL +
        " GROUP BY account, thread_id, subject, to_addresses)"
    ).execute();

    // 2) Recalculer les compteurs des SEULS dossiers "drafts" touches (le DELETE
    //    brut ne passe pas par les hooks de comptage). Cible restreinte pour
    //    rester rapide (pas de recompute global sur 42k messages).
    db.newQuery(
      "UPDATE folders SET total_count = (" +
        "SELECT COUNT(*) FROM messages WHERE messages.folder = folders.id" +
      ") WHERE type = 'drafts'"
    ).execute();

    // 3) Creer l'index unique partiel.
    const messages = app.findCollectionByNameOrId("messages");
    if (!messages.indexes.includes(DEDUP_INDEX)) {
      messages.indexes.push(DEDUP_INDEX);
      app.save(messages);
    }
  },

  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.indexes = messages.indexes.filter((i) => i !== DEDUP_INDEX);
    app.save(messages);
  }
);
