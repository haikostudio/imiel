/// <reference path="../pb_data/types.d.ts" />

// Reprise des extraits (snippet) des mails ENVOYES depuis l'app.
//
// Le worker /send ne posait pas de snippet sur le mail envoye (seuls les mails
// synchronises par IMAP en avaient un, via parser.ts). Or la ligne de
// conversation affiche desormais le DERNIER message du fil, souvent sa propre
// reponse : sans extrait, elle ne montrait que le sujet. Le worker calcule
// maintenant l'extrait a l'envoi (buildSentSnippet, parser.ts) ; cette
// migration comble l'existant avec la MEME regle (texte ecrit seulement, sans
// l'historique cite). ~100 lignes en prod : lecture des corps bornee.
// Idempotente : ne touche que les snippets vides.

migrate(
  (app) => {
    var rows = arrayOf(new DynamicModel({ "id": "", "text_body": "", "html_body": "" }));
    app.db()
      .newQuery(
        "SELECT id, COALESCE(text_body, '') AS text_body, COALESCE(html_body, '') AS html_body " +
        "FROM messages WHERE is_sent = TRUE AND is_draft = FALSE " +
        "AND (snippet IS NULL OR snippet = '')"
      )
      .all(rows);

    var stripHtml = function (html) {
      return html
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#?\w+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    var clip = function (text) {
      if (!text) return "";
      var cleaned = text
        .replace(/\r\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .replace(/^\s+/gm, "")
        .trim();
      if (cleaned.length <= 200) return cleaned;
      return cleaned.substring(0, 200).trim() + "...";
    };

    var updated = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var snippet = "";
      if (r.html_body) {
        var html = r.html_body;
        var at = html.search(/<[^>]+class="[^"]*haiko-quote|<blockquote/i);
        if (at >= 0) html = html.slice(0, at);
        snippet = clip(stripHtml(html));
      }
      if (!snippet && r.text_body) {
        var lines = r.text_body.replace(/\r\n/g, "\n").split("\n");
        var kept = [];
        for (var j = 0; j < lines.length; j++) {
          if (/^\s*>/.test(lines[j])) break;
          if (/^\s*(Le|On|Am|Il)\b.*(a [ée]crit|wrote|schrieb|ha scritto)\s*:\s*$/i.test(lines[j])) break;
          kept.push(lines[j]);
        }
        snippet = clip(kept.join("\n"));
      }
      if (!snippet) continue;
      app.db()
        .newQuery("UPDATE messages SET snippet = {:s} WHERE id = {:id}")
        .bind({ "s": snippet, "id": r.id })
        .execute();
      updated++;
    }
    console.log("065_backfill_sent_snippets: " + updated + "/" + rows.length + " snippets");
  },
  () => {
    // Pas de retour arriere : un extrait pose ne gene rien.
  }
);
