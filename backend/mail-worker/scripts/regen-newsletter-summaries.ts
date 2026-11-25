// Recalcule UNE FOIS les N syntheses newsletter les plus recentes avec la
// consigne actuelle (resume direct ~4 lignes). L'ancienne synthese reste si
// le recalcul echoue. Usage :
//   POCKETBASE_URL=... PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... OPENROUTER_API_KEY=... \
//   npx tsx scripts/regen-newsletter-summaries.ts [N=20]
import { regenerateNewsletterSummary } from "../src/newsletter";
import type { PBNewsletterPost } from "../src/pocketbase";

async function main() {
  const n = Number(process.argv[2] || 20);
  const base = process.env.POCKETBASE_URL || "http://127.0.0.1:8090";
  const auth = await fetch(`${base}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: process.env.PB_ADMIN_EMAIL, password: process.env.PB_ADMIN_PASSWORD }),
  }).then((r) => r.json() as Promise<{ token: string }>);
  const url = `${base}/api/collections/newsletter_posts/records?perPage=${n}&sort=-message_date&filter=${encodeURIComponent('status="done"')}`;
  const list = (await fetch(url, { headers: { Authorization: auth.token } }).then((r) => r.json())) as {
    items: PBNewsletterPost[];
  };
  let ok = 0;
  for (const post of list.items) {
    const done = await regenerateNewsletterSummary(post);
    console.log(`${done ? "OK  " : "KEEP"} ${post.id} ${post.title.slice(0, 60)}`);
    if (done) ok++;
  }
  console.log(`${ok}/${list.items.length} syntheses recalculees`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
