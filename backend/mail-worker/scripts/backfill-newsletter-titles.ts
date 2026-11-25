// Rattrapage UNE FOIS des titres traduits des newsletters : syntheses des N
// derniers jours (defaut 14) dont le titre est encore le sujet d'origine.
// Ne touche que `title`. Idempotent (relance = seulement ce qui reste).
// A lancer au deploiement ou sur demande de l'utilisateur, jamais seul. Usage :
//   POCKETBASE_URL=... PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... [OPENROUTER_API_KEY=...] \
//   npx tsx scripts/backfill-newsletter-titles.ts [jours=14] [--dry-run]
import { backfillNewsletterTitles } from "../src/newsletter";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const days = Number(args.find((a) => /^\d+$/.test(a)) || 14);
  const r = await backfillNewsletterTitles({ days, dryRun, log: (l) => console.log(l) });
  console.log(
    `${r.updated}/${r.candidates} titres mis a jour (${r.calls} appel(s) LLM, fenetre ${days} j${dryRun ? ", essai a blanc" : ""})`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
