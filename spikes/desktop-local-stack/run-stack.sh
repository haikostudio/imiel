#!/bin/bash
# Lance iMiel entier en 3 processus locaux, donnees dans ./appdata (aucun docker, aucun rspamd).
S="${IMIEL_SPIKE_DIR:-/tmp/imiel-desktop-spike}"
export ENCRYPTION_KEY=$(cat $S/appdata/key 2>/dev/null || (openssl rand -hex 32 | tee $S/appdata/key))
T0=$(date +%s%3N)
$S/pocketbase serve --http=127.0.0.1:18291 --dir=$S/appdata/pb_data --migrationsDir=$S/backend/pb_migrations --hooksDir=$S/backend/pb_hooks > $S/appdata/pb.log 2>&1 &
echo $! > $S/appdata/pb.pid
for i in $(seq 1 300); do curl -sf http://127.0.0.1:18291/api/health >/dev/null && break; sleep 0.2; done
T1=$(date +%s%3N); echo "base prete en $((T1-T0)) ms"
$S/pocketbase superuser upsert local@imiel.test "$(cat $S/appdata/adminpw 2>/dev/null || (openssl rand -hex 16 | tee $S/appdata/adminpw))" --dir=$S/appdata/pb_data >/dev/null 2>&1
cd $S/backend/mail-worker && PORT=18292 POCKETBASE_URL=http://127.0.0.1:18291 PB_ADMIN_EMAIL=local@imiel.test PB_ADMIN_PASSWORD=$(cat $S/appdata/adminpw) \
  PB_DATA_PATH=$S/appdata/pb_data/data.db EMBEDDINGS_CACHE_PATH=$S/appdata/worker/vectors.db FASTEMBED_CACHE_DIR=$S/backend/mail-worker/local_cache \
  NODE_ENV=production node dist/index.js > $S/appdata/worker.log 2>&1 &
echo $! > $S/appdata/worker.pid
cd $S/frontend/.next/standalone && PORT=18290 HOSTNAME=127.0.0.1 POCKETBASE_INTERNAL_URL=http://127.0.0.1:18291 WORKER_INTERNAL_URL=http://127.0.0.1:18292 MAIL_WORKER_URL=http://127.0.0.1:18292 NODE_ENV=production node server.js > $S/appdata/front.log 2>&1 &
echo $! > $S/appdata/front.pid
for i in $(seq 1 300); do curl -sf http://127.0.0.1:18292/health >/dev/null && W=1; curl -sf -o /dev/null http://127.0.0.1:18290/ && F=1; [ "$W$F" = "11" ] && break; sleep 0.2; done
T2=$(date +%s%3N); echo "worker=$W interface=$F, pile complete en $((T2-T0)) ms"
