#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Ports unifies : next=13000, worker=13001, translate=13002
NEXT_PORT=13000
WORKER_PORT=13001
TRANSLATE_PORT=13002

export PORT=$WORKER_PORT
export WORKER_INTERNAL_URL="http://127.0.0.1:${WORKER_PORT}"

echo "==> Liberation des ports ${NEXT_PORT}, ${WORKER_PORT}, ${TRANSLATE_PORT}"
lsof -ti tcp:${NEXT_PORT}      | xargs kill -9 2>/dev/null || true
lsof -ti tcp:${WORKER_PORT}    | xargs kill -9 2>/dev/null || true
lsof -ti tcp:${TRANSLATE_PORT} | xargs kill -9 2>/dev/null || true
rm -f frontend/.next/dev/lock 2>/dev/null || true

if [ ! -d "node_modules" ]; then
  echo "==> Installation des deps racine"
  npm install
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "==> Installation des deps frontend"
  (cd frontend && npm install)
fi

if [ ! -d "backend/mail-worker/node_modules" ]; then
  echo "==> Installation des deps mail-worker"
  (cd backend/mail-worker && npm install)
fi

npx concurrently -k \
  -n worker,next,translate \
  -c yellow,green,magenta \
  "PORT=${WORKER_PORT} npm run dev:worker" \
  "WORKER_INTERNAL_URL=http://127.0.0.1:${WORKER_PORT} npm run dev:next" \
  "libretranslate --host 127.0.0.1 --port ${TRANSLATE_PORT} --disable-web-ui"
