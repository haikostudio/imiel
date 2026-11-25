// Controle rejouable de la recherche de mails, sur une COPIE de la base (jamais
// le serveur en ligne) :
//   PB_DATA_PATH=/chemin/pb_data SEARCH_INDEX_PATH=/chemin/search.db \
//     npx tsx scripts/verifier-recherche.ts <userId> [mot attendu ...]
//
// Construit l'index s'il manque (duree affichee), puis verifie :
//   - debut de mot : chaque mot attendu rend autant de resultats tronque d'une
//     lettre ("labo" -> "inovi") que complet, et au moins un ;
//   - bruit de mise en page : "width", "font", "table", "style" ne ressortent
//     plus la quasi-totalite de la boite ;
//   - mots courants : "contact", "document", "projet" rendent des resultats ;
//   - memes resultats partout : le nombre annonce par dossier dans la palette
//     egale le total de la liste de ce dossier ("Voir tout"), page par page ;
//   - saisies speciales : guillemets, tirets, *, :, parentheses sans erreur.
import { syncSearchIndex, getSearchIndexState } from "../src/search-index";
import { runMailSearch } from "../src/mail-search";
import { getPbDb } from "../src/sqlite-direct";

const userId = process.argv[2];
const expected = process.argv.slice(3);
if (!userId) {
  console.error("usage: verifier-recherche.ts <userId> [mot attendu ...]");
  process.exit(2);
}

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "ok    " : "ECHEC "} ${label}`);
  if (!ok) failures++;
};

(async () => {
  const t0 = Date.now();
  await syncSearchIndex();
  const st = getSearchIndexState();
  console.log(`index : ${st.done} mails, pret=${st.ready}, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  const pb = getPbDb();
  if (!pb || !st.ready) {
    console.error("index ou data.db indisponible");
    process.exit(2);
  }
  const mailbox = (
    pb.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN accounts a ON a.id = m.account WHERE a.user = ?`
    ).get(userId) as { c: number }
  ).c;
  const folders = pb
    .prepare(
      `SELECT f.id AS id, f.type AS type FROM folders f JOIN accounts a ON a.id = f.account WHERE a.user = ?`
    )
    .all(userId) as Array<{ id: string; type: string }>;
  const total = async (query: string) => {
    const t = Date.now();
    const r = await runMailSearch({ userId, query, perPage: 200, sort: "date" });
    return { r, ms: Date.now() - t };
  };

  for (const word of expected) {
    const full = await total(word);
    const cut = await total(word.slice(0, -1));
    check(
      !!full.r && full.r.totalItems > 0 && !!cut.r && cut.r.totalItems >= full.r.totalItems,
      `"${word.slice(0, -1)}" rend ${cut.r?.totalItems} resultats, "${word}" ${full.r?.totalItems} (${cut.ms} ms)`
    );
  }

  for (const noise of ["width", "font", "table", "style"]) {
    const { r, ms } = await total(noise);
    check(!!r && r.totalItems < mailbox * 0.2, `"${noise}" : ${r?.totalItems} / ${mailbox} mails (${ms} ms)`);
  }

  for (const common of ["contact", "document", "projet"]) {
    const { r, ms } = await total(common);
    check(!!r && r.totalItems > 0, `"${common}" : ${r?.totalItems} resultats (${ms} ms)`);
  }

  for (const q of [...expected, "contact"]) {
    const palette = await runMailSearch({ userId, query: q, perPage: 200 });
    if (!palette) {
      check(false, `palette "${q}" indisponible`);
      continue;
    }
    for (const type of Object.keys(palette.counts)) {
      const folderIds = folders.filter((f) => f.type === type).map((f) => f.id);
      const seen = new Set<string>();
      let announced = 0;
      for (let page = 1; ; page++) {
        // Meme perimetre que l'ecran (useThreads / useMessages).
        const list = await runMailSearch({
          userId,
          query: q,
          page,
          perPage: 50,
          scope: { folderIds, isDraft: type === "drafts", excludeSecondary: type === "inbox" },
        });
        if (!list) break;
        announced = list.totalItems;
        for (const it of list.items) seen.add(it.id);
        if (page >= list.totalPages) break;
      }
      check(
        announced === palette.counts[type] && seen.size === announced,
        `"${q}" dossier ${type} : palette ${palette.counts[type]}, liste ${announced}, lignes parcourues ${seen.size}`
      );
    }
  }

  for (const q of ['in"ovi', "inovi*", "-inovi", "(inovi)", "inovi:", "AND", "OR x", "NEAR(a b)", "^a", "a@b.c", "l'avis", "rendez-vous", "*", '""']) {
    try {
      const r = await runMailSearch({ userId, query: q, sort: "date" });
      check(r !== null, `saisie ${JSON.stringify(q)} : ${r?.totalItems} resultats`);
    } catch (err) {
      check(false, `saisie ${JSON.stringify(q)} : ${(err as Error).message}`);
    }
  }

  console.log(failures ? `\n${failures} controle(s) en echec` : "\ntous les controles passent");
  process.exit(failures ? 1 : 0);
})();
